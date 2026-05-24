import React, { useEffect, useMemo, useState } from 'react';

const runtimeConfig = window.TRACKY_CONFIG || {};
const APP_NAME = runtimeConfig.APP_NAME || 'TRACKY';
const APP_DESC = runtimeConfig.APP_DESC || 'Department Time Tracking Control Panel';
const TAB_TITLE = runtimeConfig.TAB_TITLE || 'Tracky';
const isDevServer = ['3001', '3002', '3003'].includes(window.location.port);
const API_BASE = runtimeConfig.API_BASE || (isDevServer ? 'http://localhost:3100' : '');
const AUTH_KEY = 'tracky_auth';
const NO_SUBDIVISION_LABEL = 'No subdivision (department only)';
const TIME_MODE_LOCAL = 'local';
const TIME_MODE_ZULU = 'zulu';
const CLOCK_FORMAT_12 = '12h';
const CLOCK_FORMAT_24 = '24h';
const LOG_MONTH_ALL = 'all';
const PERSONAL_TEAM_ID = 'personal';
const DOJ_TEAM_ID = 'doj';
const PATROL_RESUME_WINDOW_MS = 5 * 60 * 1000;
const BCSO_RANKS = [
  'Probationary Reserve Deputy', 'Reserve Deputy', 'Senior Reserve Deputy', 'Probationary Deputy',
  'Deputy I', 'Deputy II', 'Deputy III', 'Senior Deputy', 'Master Deputy', 'Corporal',
  'Senior Corporal', 'Sergeant', 'Staff Sergeant', 'Master Sergeant', 'Lieutenant', 'Captain',
  'Sheriff Major', 'Sheriff Commander', 'Sheriff Colonel'
];
const EMPTY_DOJ_PROFILE = {
  communityName: '', email: '', websiteId: '', idn: '', investigatorRank: '', bcsoRank: '', callsigns: {}
};
const DOJ_FORM_DEPARTMENT_IDS = new Set([
  'civilian-department',
  'los-santos-police-department',
  'san-andreas-highway-patrol',
  'blaine-county-sheriff-s-office',
  'communications-department',
  'los-santos-fire-department'
]);

const dateTimeInputValue = (value, timeMode = TIME_MODE_LOCAL, includeSubMinutePrecision = false) => {
  const date = new Date(value);
  const precision = includeSubMinutePrecision ? 23 : 16;
  if (timeMode === TIME_MODE_ZULU) return date.toISOString().slice(0, precision);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, precision);
};
const parseDateTimeInput = (value, timeMode = TIME_MODE_LOCAL) => (
  new Date(timeMode === TIME_MODE_ZULU ? `${value}${value.length === 16 ? ':00' : ''}Z` : value).toISOString()
);
const formatDateTime = (value, timeMode = TIME_MODE_LOCAL, clockFormat = CLOCK_FORMAT_12) => `${new Date(value).toLocaleString([], {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: clockFormat === CLOCK_FORMAT_24 ? 'h23' : 'h12',
  ...(timeMode === TIME_MODE_ZULU ? { timeZone: 'UTC' } : {})
})}${timeMode === TIME_MODE_ZULU ? ' Z' : ''}`;
const formatDuration = hours => {
  const minutes = Math.max(0, Math.round(hours * 60));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const durationHours = (entry, now = Date.now(), range) => {
  const start = Math.max(new Date(entry.startAt).getTime(), range?.start || -Infinity);
  const end = Math.min(entry.endAt ? new Date(entry.endAt).getTime() : now, range?.end || Infinity);
  return Math.max(0, end - start) / 3600000;
};
const patrolSegments = entry => entry?.segments?.length ? entry.segments : entry ? [{
  id: `${entry.id}-segment-1`,
  subdivisionId: entry.subdivisionId || '',
  subdivisionName: entry.subdivisionName || '',
  startAt: entry.startAt,
  endAt: entry.endAt
}] : [];
const assignmentName = segment => segment?.subdivisionName || 'Department only';
const monthKey = (value, timeMode = TIME_MODE_LOCAL) => {
  const date = new Date(value);
  const year = timeMode === TIME_MODE_ZULU ? date.getUTCFullYear() : date.getFullYear();
  const month = timeMode === TIME_MODE_ZULU ? date.getUTCMonth() : date.getMonth();
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};
const monthLabel = (key, timeMode = TIME_MODE_LOCAL) => {
  const [year, month] = key.split('-').map(Number);
  const date = timeMode === TIME_MODE_ZULU ? new Date(Date.UTC(year, month - 1, 1)) : new Date(year, month - 1, 1);
  return date.toLocaleString([], {
    month: 'long',
    year: 'numeric',
    ...(timeMode === TIME_MODE_ZULU ? { timeZone: 'UTC' } : {})
  });
};
const monthRange = (timeMode, now = new Date()) => {
  if (timeMode === TIME_MODE_ZULU) {
    return {
      start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      label: `${now.toLocaleString([], { month: 'long', year: 'numeric', timeZone: 'UTC' })} / ZULU`
    };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    start: start.getTime(),
    end: end.getTime(),
    label: `${now.toLocaleString([], { month: 'long', year: 'numeric' })} / LOCAL`
  };
};
const emptyManualEntry = (timeMode = TIME_MODE_LOCAL) => {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return {
    departmentId: '',
    subdivisionId: '',
    note: '',
    startAt: dateTimeInputValue(start, timeMode),
    endAt: dateTimeInputValue(end, timeMode)
  };
};

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [teamKey, setTeamKey] = useState('');
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/registration`)
      .then(response => response.ok ? response.json() : { enabled: false })
      .then(body => setRegistrationEnabled(body.enabled === true))
      .catch(() => setRegistrationEnabled(false));
  }, []);

  const submit = async event => {
    event.preventDefault();
    setError('');
    if (registering && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const response = await fetch(`${API_BASE}/api/auth/${registering ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registering ? { username, password, teamKey } : { username, password })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || (registering ? 'Unable to create account.' : 'Unable to sign in.'));
      return;
    }
    localStorage.setItem(AUTH_KEY, JSON.stringify(body));
    onLogin(body);
  };
  const switchMode = () => {
    setRegistering(current => !current);
    setConfirmPassword('');
    setTeamKey('');
    setError('');
  };
  const canSubmit = username && password && (!registering || (confirmPassword && password === confirmPassword));

  return (
    <main className="control-panel auth-page">
      <section className="desk-card auth-card">
        <p className="eyebrow">Operations Console</p>
        <h1>{APP_NAME}</h1>
        <p className="muted">{APP_DESC}</p>
        <form className="compact-form" onSubmit={submit}>
          <div className="form-group">
            <label htmlFor="login-username">Username</label>
            <input id="login-username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <input id="login-password" type="password" minLength={registering ? 6 : undefined} value={password} onChange={event => setPassword(event.target.value)} autoComplete={registering ? 'new-password' : 'current-password'} required />
          </div>
          {registering && (
            <>
              <div className="form-group">
                <label htmlFor="register-confirm-password">Confirm Password</label>
                <input id="register-confirm-password" type="password" minLength="6" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
              </div>
              <div className="form-group">
                <label htmlFor="register-team-key">Team Key</label>
                <input id="register-team-key" value={teamKey} onChange={event => setTeamKey(event.target.value)} placeholder="Optional team key" />
                <small className="muted">Leave blank to use Personal Departments only.</small>
              </div>
            </>
          )}
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className={canSubmit ? 'btn-primary' : 'btn-toggle'}>
            {registering ? 'Create Account' : 'Sign In'}
          </button>
        </form>
        {registrationEnabled && (
          <p className="auth-switch">
            {registering ? 'Already have an account?' : 'Need an account?'}
            <button type="button" className="btn-link" onClick={switchMode}>
              {registering ? 'Sign In' : 'Create Account'}
            </button>
          </p>
        )}
      </section>
    </main>
  );
}

function ProgressBar({ worked, required }) {
  const percentage = required > 0 ? Math.min(100, (worked / required) * 100) : 0;
  const goalClass = required <= 0
    ? 'no-goal'
    : percentage >= 100
      ? 'goal-complete'
      : percentage >= 75
        ? 'goal-high'
        : percentage >= 50
          ? 'goal-mid'
          : percentage >= 25
            ? 'goal-low'
            : 'goal-start';
  return (
    <div className="progress">
      <div className="progress-track">
        <span className={goalClass} style={{ width: `${percentage}%` }} />
      </div>
      <span>{required > 0 ? `${formatDuration(worked)} / ${formatDuration(required)} tracked` : `${formatDuration(worked)} tracked`}</span>
    </div>
  );
}

function CollapsiblePanel({ title, defaultOpen = false, open: controlledOpen, onOpenChange, headerExtra, className = '', children }) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen === undefined ? internalOpen : controlledOpen;
  const setOpen = nextOpen => {
    if (onOpenChange) onOpenChange(nextOpen);
    else setInternalOpen(nextOpen);
  };
  return (
    <details
      className={`desk-card full-width-card collapsible-panel ${className}`}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="panel-summary">
        <h2>{title}</h2>
        {headerExtra}
      </summary>
      <div className="panel-content">{children}</div>
    </details>
  );
}

function SubdivisionOptions({ subdivisions }) {
  const option = subdivision => (
    <option key={subdivision.id} value={subdivision.id}>
      {subdivision.name}{subdivision.enabled === false ? ' (disabled)' : ''}
    </option>
  );
  return (
    <>
      {subdivisions.map((subdivision, index) => (
        <React.Fragment key={subdivision.id}>
          {subdivision.group && subdivisions[index - 1]?.group !== subdivision.group && (
            <option disabled value={`__group_${subdivision.group}_${index}`}>--- {subdivision.group} ---</option>
          )}
          {option(subdivision)}
        </React.Fragment>
      ))}
    </>
  );
}

function DepartmentOptions({ departments, teams }) {
  return (
    <>
      {teams.map(team => {
        const teamDepartments = departments.filter(department => department.teamId === team.id);
        if (!teamDepartments.length) return null;
        return (
          <React.Fragment key={team.id}>
            <option disabled value={`__team_${team.id}`}>--- {team.name} ---</option>
            {teamDepartments.map(department => (
              <option key={department.id} value={department.id}>{department.name}</option>
            ))}
          </React.Fragment>
        );
      })}
    </>
  );
}

function Dashboard({ auth, onLogout, onAuthUpdate }) {
  const [departments, setDepartments] = useState([]);
  const [entries, setEntries] = useState([]);
  const [teams, setTeams] = useState([]);
  const [adminTeams, setAdminTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [activePatrols, setActivePatrols] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [timeMode, setTimeMode] = useState(() =>
    localStorage.getItem(`tracky_time_mode:${auth.user.username}`) === TIME_MODE_ZULU ? TIME_MODE_ZULU : TIME_MODE_LOCAL
  );
  const [clockFormat, setClockFormat] = useState(() =>
    localStorage.getItem(`tracky_clock_format:${auth.user.username}`) === CLOCK_FORMAT_24 ? CLOCK_FORMAT_24 : CLOCK_FORMAT_12
  );
  const [clockForm, setClockForm] = useState({ departmentId: '', subdivisionId: '', note: '' });
  const [nextSubdivisionId, setNextSubdivisionId] = useState('');
  const [manualForm, setManualForm] = useState(() => emptyManualEntry(timeMode));
  const [editingEntryId, setEditingEntryId] = useState('');
  const [editEntryForm, setEditEntryForm] = useState(null);
  const [originalEditEntryForm, setOriginalEditEntryForm] = useState(null);
  const [newDepartment, setNewDepartment] = useState({ name: '', requiredHours: 0, color: '#4a5568', teamId: PERSONAL_TEAM_ID });
  const [newSubdivisions, setNewSubdivisions] = useState({});
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user', teamIds: [DOJ_TEAM_ID] });
  const [newTeam, setNewTeam] = useState({ name: '', joinKey: '', lockDepartments: false, lockSubdivisions: false, personalized: false });
  const [joinKey, setJoinKey] = useState('');
  const [usernameForm, setUsernameForm] = useState(auth.user.username);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [dojProfile, setDojProfile] = useState(EMPTY_DOJ_PROFILE);
  const [savedDojProfile, setSavedDojProfile] = useState(EMPTY_DOJ_PROFILE);
  const [savedDepartments, setSavedDepartments] = useState([]);
  const [draggedItem, setDraggedItem] = useState(null);
  const [dragOverItem, setDragOverItem] = useState(null);
  const [expandedTeams, setExpandedTeams] = useState({});
  const [adminPanelsOpen, setAdminPanelsOpen] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [logMonthFilter, setLogMonthFilter] = useState(() => monthKey(new Date(), timeMode));
  const [logDepartmentFilter, setLogDepartmentFilter] = useState('');

  const request = async (path, options = {}) => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      localStorage.removeItem(AUTH_KEY);
      onLogout();
      throw new Error('Your session has expired.');
    }
    if (!response.ok) throw new Error(body.error || 'Request failed.');
    return body;
  };

  const runAction = async (action, successMessage) => {
    setError('');
    setMessage('');
    try {
      await action();
      if (successMessage) setMessage(successMessage);
    } catch (actionError) {
      setError(actionError.message);
    }
  };

  const loadActivePatrols = async () => {
    if (auth.user.role !== 'admin') return [];
    const result = await request('/api/admin/active-patrols');
    setActivePatrols(result);
    return result;
  };
  const loadWorkspace = async () => {
    const [workspace] = await Promise.all([
      request('/api/bootstrap'),
      loadActivePatrols()
    ]);
    setDepartments(workspace.departments);
    setSavedDepartments(workspace.departments);
    setEntries(workspace.entries);
    setTeams(workspace.teams || []);
    const profile = {
      ...EMPTY_DOJ_PROFILE,
      ...(workspace.dojProfile || {}),
      callsigns: workspace.dojProfile?.callsigns || {}
    };
    setDojProfile(profile);
    setSavedDojProfile(profile);
    setNow(Date.now());
  };
  const loadUsers = async () => {
    if (auth.user.role !== 'admin') return;
    const result = await request('/api/users');
    setUsers(result.map(user => ({
      ...user,
      originalUsername: user.username,
      originalRole: user.role,
      originalTeamIds: user.teamIds || [],
      pendingPassword: ''
    })));
  };
  const loadAdminTeams = async () => {
    if (auth.user.role !== 'admin') return;
    const result = await request('/api/admin/teams');
    setAdminTeams(result.map(team => ({ ...team, original: { ...team } })));
  };
  const loadAdminSettings = async () => {
    if (auth.user.role !== 'admin') return;
    const result = await request('/api/admin/settings');
    setRegistrationEnabled(result.allowRegistration === true);
  };

  useEffect(() => {
    document.title = TAB_TITLE;
  }, []);

  useEffect(() => {
    if (!message && !error) return undefined;
    const timer = setTimeout(() => {
      setMessage('');
      setError('');
    }, 5000);
    return () => clearTimeout(timer);
  }, [message, error]);

  useEffect(() => {
    runAction(async () => {
      await loadWorkspace();
      await loadUsers();
      await loadAdminTeams();
      await loadAdminSettings();
    });
  }, [auth.token]);

  useEffect(() => {
    if (auth.user.role !== 'admin') return undefined;
    const timer = setInterval(() => {
      loadActivePatrols().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [auth.token, auth.user.role]);

  const activeEntry = entries.find(entry => !entry.endAt);
  const hasResumableEntry = entries.some(entry => {
    const elapsed = entry.endAt ? now - new Date(entry.endAt).getTime() : PATROL_RESUME_WINDOW_MS + 1;
    return elapsed >= 0 && elapsed <= PATROL_RESUME_WINDOW_MS;
  });
  const activePatrolSegments = patrolSegments(activeEntry);
  const currentPatrolSegment = activePatrolSegments[activePatrolSegments.length - 1];
  const activeDepartments = useMemo(() => departments
    .filter(department => department.enabled !== false && department.teamEnabled !== false)
    .map(department => ({
      ...department,
      subdivisions: department.subdivisions.filter(subdivision => subdivision.enabled !== false)
    })), [departments]);
  const editableDepartmentTeams = teams.filter(team =>
    auth.user.role === 'admin' || team.personalized || !team.lockDepartments
  );
  const departmentGroups = teams.map(team => ({
    ...team,
    departments: departments.filter(department => department.teamId === team.id)
  }));
  const isDojMember = teams.some(team => team.id === DOJ_TEAM_ID);
  const visibleDojDepartments = departments.filter(department =>
    department.teamId === DOJ_TEAM_ID && department.teamEnabled !== false && department.enabled !== false
  );
  const hasVisibleSid = visibleDojDepartments.some(department =>
    department.name === 'Los Santos Police Department' &&
    department.subdivisions.some(subdivision => subdivision.name === 'Special Intelligence Division' && subdivision.enabled !== false)
  );
  const hasVisibleBcso = visibleDojDepartments.some(department => department.name === "Blaine County Sheriff's Office");

  useEffect(() => {
    if (!editableDepartmentTeams.some(team => team.id === newDepartment.teamId)) {
      setNewDepartment(current => ({ ...current, teamId: editableDepartmentTeams[0]?.id || PERSONAL_TEAM_ID }));
    }
  }, [teams.map(team => team.id).join('|'), auth.user.role]);

  useEffect(() => {
    if (!activeEntry && activePatrols.length === 0 && !hasResumableEntry) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeEntry, activePatrols.length, hasResumableEntry]);

  useEffect(() => {
    if (activeDepartments.length === 0) {
      setClockForm(current => ({ ...current, departmentId: '', subdivisionId: '' }));
      setManualForm(current => ({ ...current, departmentId: '', subdivisionId: '' }));
      return;
    }
    setClockForm(current => {
      const department = activeDepartments.find(item => item.id === current.departmentId) || activeDepartments[0];
      const subdivisionId = current.subdivisionId === '' ||
        department.subdivisions.some(item => item.id === current.subdivisionId)
        ? current.subdivisionId
        : '';
      return {
        ...current,
        departmentId: department.id,
        subdivisionId
      };
    });
    setManualForm(current => {
      const department = activeDepartments.find(item => item.id === current.departmentId) || activeDepartments[0];
      const subdivisionId = current.subdivisionId === '' ||
        department.subdivisions.some(item => item.id === current.subdivisionId)
        ? current.subdivisionId
        : '';
      return {
        ...current,
        departmentId: department.id,
        subdivisionId
      };
    });
  }, [activeDepartments]);

  const clockDepartment = activeDepartments.find(department => department.id === clockForm.departmentId);
  const activePatrolDepartment = activeDepartments.find(department => department.id === activeEntry?.departmentId);
  const usedPatrolSubdivisionIds = new Set(activePatrolSegments.map(segment => segment.subdivisionId).filter(Boolean));
  const canSwitchToDepartmentOnly = currentPatrolSegment?.subdivisionId !== '';
  const selectablePatrolSubdivisions = activePatrolDepartment?.subdivisions.filter(subdivision =>
    subdivision.id !== currentPatrolSegment?.subdivisionId &&
    (usedPatrolSubdivisionIds.has(subdivision.id) || usedPatrolSubdivisionIds.size < 3)
  ) || [];
  const manualDepartment = activeDepartments.find(department => department.id === manualForm.departmentId);
  const editingEntry = entries.find(entry => entry.id === editingEntryId);
  const editingHiddenDepartment = departments.find(department =>
    department.id === editingEntry?.departmentId && department.enabled === false
  );
  const editDepartmentOptions = editingHiddenDepartment
    ? [...activeDepartments, editingHiddenDepartment]
    : activeDepartments;
  const editDepartment = editDepartmentOptions.find(department => department.id === editEntryForm?.departmentId);
  const editSourceDepartment = departments.find(department => department.id === editEntryForm?.departmentId);
  const editingHiddenSubdivision = editSourceDepartment?.subdivisions.find(subdivision =>
    subdivision.id === editingEntry?.subdivisionId && subdivision.enabled === false
  );
  const editSubdivisionOptions = [
    ...(editDepartment?.subdivisions.filter(subdivision => subdivision.enabled !== false) || []),
    ...(editingHiddenSubdivision ? [editingHiddenSubdivision] : [])
  ];
  const editingMultipleSegments = (editEntryForm?.segments?.length || 0) > 1;
  const editSegmentSubdivisionOptions = subdivisionId => {
    const enabled = editDepartment?.subdivisions.filter(subdivision => subdivision.enabled !== false) || [];
    const hidden = editSourceDepartment?.subdivisions.find(subdivision =>
      subdivision.id === subdivisionId && subdivision.enabled === false
    );
    return hidden ? [...enabled, hidden] : enabled;
  };
  const editedSubdivisionIds = new Set((editEntryForm?.segments || patrolSegments(editingEntry))
    .map(segment => segment.subdivisionId)
    .filter(Boolean));
  const missedSubdivisionOptions = editDepartment?.subdivisions.filter(subdivision =>
    subdivision.enabled !== false &&
    (editedSubdivisionIds.has(subdivision.id) || editedSubdivisionIds.size < 3)
  ) || [];
  const currentMonth = monthRange(timeMode, new Date(now));
  const monthlyEntries = entries.filter(entry =>
    new Date(entry.startAt).getTime() < currentMonth.end &&
    (!entry.endAt || new Date(entry.endAt).getTime() > currentMonth.start)
  );

  const progress = useMemo(() => activeDepartments.map(department => ({
    ...department,
    worked: monthlyEntries
      .filter(entry => entry.departmentId === department.id)
      .reduce((total, entry) => total + durationHours(entry, now, currentMonth), 0),
    subdivisions: department.subdivisions.map(subdivision => ({
      ...subdivision,
      worked: monthlyEntries
        .reduce((total, entry) => total + patrolSegments(entry)
          .filter(segment => segment.subdivisionId === subdivision.id)
          .reduce((segmentTotal, segment) => segmentTotal + durationHours(segment, now, currentMonth), 0), 0)
    }))
  })), [activeDepartments, monthlyEntries, now, currentMonth.start, currentMonth.end]);

  useEffect(() => {
    if (!activeEntry || (!canSwitchToDepartmentOnly && selectablePatrolSubdivisions.length === 0)) {
      setNextSubdivisionId('');
      return;
    }
    setNextSubdivisionId(canSwitchToDepartmentOnly ? '' : selectablePatrolSubdivisions[0]?.id || '');
  }, [activeEntry?.id, currentPatrolSegment?.subdivisionId, activePatrolDepartment?.id, canSwitchToDepartmentOnly, selectablePatrolSubdivisions.map(subdivision => subdivision.id).join('|')]);

  const totalWorked = progress.reduce((total, department) => total + department.worked, 0);
  const totalRequired = progress.reduce((total, department) => total + Number(department.requiredHours || 0), 0);
  const departmentNameFor = entry => departments.find(department => department.id === entry.departmentId)?.name || entry.departmentName;
  const departmentColorFor = entry => departments.find(department => department.id === entry.departmentId)?.color || '#4a5568';
  const canFileDojEntry = entry => {
    const department = departments.find(item => item.id === entry.departmentId);
    return isDojMember && Boolean(entry.endAt) && department?.teamId === DOJ_TEAM_ID &&
      DOJ_FORM_DEPARTMENT_IDS.has(department.id);
  };
  const subdivisionNameFor = (entry, subdivisionId, fallbackName = '') => {
    if (!subdivisionId) return 'Department only';
    return departments.find(department => department.id === entry.departmentId)?.subdivisions
      .find(subdivision => subdivision.id === subdivisionId)?.name || fallbackName || 'Unknown subdivision';
  };
  const groupedEntryAssignments = entry => {
    const grouped = new Map();
    patrolSegments(entry).forEach(segment => {
      const key = segment.subdivisionId || '__department_only__';
      const current = grouped.get(key) || {
        subdivisionId: segment.subdivisionId || '',
        fallbackName: segment.subdivisionName || '',
        worked: 0
      };
      current.worked += durationHours(segment, now);
      grouped.set(key, current);
    });
    return Array.from(grouped.values()).map(item => ({
      ...item,
      name: subdivisionNameFor(entry, item.subdivisionId, item.fallbackName)
    }));
  };
  const availableLogMonths = Array.from(new Set([
    monthKey(new Date(), timeMode),
    ...entries.map(entry => monthKey(entry.startAt, timeMode))
  ])).sort().reverse();
  const historicalDepartments = entries.filter(entry =>
    !departments.some(department => department.id === entry.departmentId)
  ).reduce((items, entry) => items.some(item => item.id === entry.departmentId)
    ? items
    : [...items, { id: entry.departmentId, name: entry.departmentName }], []);
  const logDepartmentOptions = [...departments, ...historicalDepartments];
  const filteredLogEntries = entries.filter(entry =>
    (logMonthFilter === LOG_MONTH_ALL || monthKey(entry.startAt, timeMode) === logMonthFilter) &&
    (!logDepartmentFilter || entry.departmentId === logDepartmentFilter)
  );

  useEffect(() => {
    const currentKey = monthKey(new Date(), timeMode);
    setLogMonthFilter(current => current === LOG_MONTH_ALL || availableLogMonths.includes(current) ? current : currentKey);
  }, [timeMode, entries.map(entry => entry.startAt).join('|')]);

  const updateDepartmentDraft = (id, field, value) => setDepartments(current =>
    current.map(department => department.id === id ? { ...department, [field]: value } : department)
  );
  const updateSubdivisionDraft = (departmentId, subdivisionId, field, value) => setDepartments(current =>
    current.map(department => department.id !== departmentId ? department : {
      ...department,
      subdivisions: department.subdivisions.map(subdivision =>
        subdivision.id === subdivisionId ? { ...subdivision, [field]: value } : subdivision
      )
    })
  );
  const savedDepartmentFor = id => savedDepartments.find(department => department.id === id);
  const departmentHasChanges = department => {
    const saved = savedDepartmentFor(department.id);
    return !saved || saved.name !== department.name || Number(saved.requiredHours) !== Number(department.requiredHours) ||
      (saved.color || '#4a5568') !== (department.color || '#4a5568');
  };
  const subdivisionHasChanges = (departmentId, subdivision) => {
    const saved = savedDepartmentFor(departmentId)?.subdivisions.find(item => item.id === subdivision.id);
    return !saved || saved.name !== subdivision.name || Number(saved.requiredHours) !== Number(subdivision.requiredHours);
  };
  const hasPendingStructureChanges = departments.some(department =>
    departmentHasChanges(department) ||
    department.subdivisions.some(subdivision => subdivisionHasChanges(department.id, subdivision))
  );
  const setClockMode = nextMode => {
    if (nextMode === timeMode) return;
    const convertInput = (value, includeSubMinutePrecision = false) => value
      ? dateTimeInputValue(parseDateTimeInput(value, timeMode), nextMode, includeSubMinutePrecision)
      : '';
    setManualForm(current => ({
      ...current,
      startAt: convertInput(current.startAt),
      endAt: convertInput(current.endAt)
    }));
    setEditEntryForm(current => current ? ({
      ...current,
      startAt: convertInput(current.startAt, Boolean(current.segments)),
      endAt: convertInput(current.endAt, Boolean(current.segments)),
      segments: current.segments?.map(segment => ({
        ...segment,
        startAt: convertInput(segment.startAt, true),
        endAt: convertInput(segment.endAt, true)
      }))
    }) : current);
    setOriginalEditEntryForm(current => current ? ({
      ...current,
      startAt: convertInput(current.startAt, Boolean(current.segments)),
      endAt: convertInput(current.endAt, Boolean(current.segments)),
      segments: current.segments?.map(segment => ({
        ...segment,
        startAt: convertInput(segment.startAt, true),
        endAt: convertInput(segment.endAt, true)
      }))
    }) : current);
    localStorage.setItem(`tracky_time_mode:${auth.user.username}`, nextMode);
    setTimeMode(nextMode);
  };
  const setDisplayClockFormat = nextFormat => {
    localStorage.setItem(`tracky_clock_format:${auth.user.username}`, nextFormat);
    setClockFormat(nextFormat);
  };

  const createClockEntry = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/entries', {
        method: 'POST',
        body: JSON.stringify(clockForm)
      });
      setClockForm(current => ({ ...current, note: '' }));
      await loadWorkspace();
    }, 'Department patrol started.');
  };
  const activateSubdivision = event => {
    event.preventDefault();
    runAction(async () => {
      await request(`/api/entries/${activeEntry.id}/subdivisions`, {
        method: 'POST',
        body: JSON.stringify({ subdivisionId: nextSubdivisionId })
      });
      setNextSubdivisionId('');
      await loadWorkspace();
    }, 'Subdivision activated in this patrol.');
  };
  const clockOut = () => runAction(async () => {
    await request(`/api/entries/${activeEntry.id}/clock-out`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    await loadWorkspace();
  }, 'Department patrol ended.');
  const addManualEntry = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/entries', {
        method: 'POST',
        body: JSON.stringify({
          ...manualForm,
          startAt: parseDateTimeInput(manualForm.startAt, timeMode),
          endAt: parseDateTimeInput(manualForm.endAt, timeMode)
        })
      });
      setManualForm(current => ({ ...emptyManualEntry(timeMode), departmentId: current.departmentId, subdivisionId: current.subdivisionId }));
      await loadWorkspace();
    }, 'Shift added.');
  };
  const deleteEntry = entry => {
    if (!window.confirm(`Delete the ${entry.departmentName} patrol from ${formatDateTime(entry.startAt, timeMode, clockFormat)}?`)) return;
    runAction(async () => {
      await request(`/api/entries/${entry.id}`, { method: 'DELETE' });
      if (editingEntryId === entry.id) {
        setEditingEntryId('');
        setEditEntryForm(null);
      }
      await loadWorkspace();
    }, 'Shift removed.');
  };
  const canResumeEntry = entry => {
    if (!entry.endAt) return false;
    const elapsed = now - new Date(entry.endAt).getTime();
    return elapsed >= 0 && elapsed <= PATROL_RESUME_WINDOW_MS;
  };
  const resumeEntry = entry => runAction(async () => {
    await request(`/api/entries/${entry.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    await loadWorkspace();
  }, 'Department patrol resumed.');
  const fileLog = entry => {
    const formWindow = window.open('', '_blank');
    if (formWindow) formWindow.opener = null;
    runAction(async () => {
      try {
        const result = await request(`/api/entries/${entry.id}/file-log`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        if (formWindow) formWindow.location.href = result.url;
        else window.open(result.url, '_blank', 'noopener,noreferrer');
        await loadWorkspace();
      } catch (actionError) {
        if (formWindow) formWindow.close();
        throw actionError;
      }
    }, 'Pre-filled Google Form opened.');
  };
  const startEditEntry = entry => {
    const form = {
      departmentId: entry.departmentId,
      subdivisionId: entry.subdivisionId || '',
      note: entry.note || '',
      startAt: dateTimeInputValue(entry.startAt, timeMode, patrolSegments(entry).length > 1),
      endAt: entry.endAt ? dateTimeInputValue(entry.endAt, timeMode, patrolSegments(entry).length > 1) : '',
      ...(patrolSegments(entry).length > 1 ? {
        segments: patrolSegments(entry).map(segment => ({
          id: segment.id,
          subdivisionId: segment.subdivisionId || '',
          startAt: dateTimeInputValue(segment.startAt, timeMode, true),
          endAt: segment.endAt ? dateTimeInputValue(segment.endAt, timeMode, true) : ''
        }))
      } : {})
    };
    setEditingEntryId(entry.id);
    setEditEntryForm(form);
    setOriginalEditEntryForm(form);
  };
  const cancelEditEntry = () => {
    setEditingEntryId('');
    setEditEntryForm(null);
    setOriginalEditEntryForm(null);
  };
  const addMissedSubdivision = () => {
    if (!editEntryForm || !editingEntry?.endAt || missedSubdivisionOptions.length === 0) return;
    const existingSegments = editEntryForm.segments || patrolSegments(editingEntry).map(segment => ({
      id: segment.id,
      subdivisionId: segment.subdivisionId || '',
      startAt: dateTimeInputValue(segment.startAt, timeMode, true),
      endAt: segment.endAt ? dateTimeInputValue(segment.endAt, timeMode, true) : ''
    }));
    const endAt = editEntryForm.endAt || existingSegments[existingSegments.length - 1]?.endAt || '';
    setEditEntryForm({
      ...editEntryForm,
      segments: [...existingSegments, {
        id: `added-${Date.now()}`,
        subdivisionId: missedSubdivisionOptions[0].id,
        startAt: endAt,
        endAt
      }]
    });
  };
  const saveEntry = event => {
    event.preventDefault();
    runAction(async () => {
      const body = editEntryForm.segments ? {
        departmentId: editEntryForm.departmentId,
        note: editEntryForm.note,
        endAt: editEntryForm.endAt ? parseDateTimeInput(editEntryForm.endAt, timeMode) : null,
        segments: editEntryForm.segments.map(segment => ({
          ...segment,
          startAt: parseDateTimeInput(segment.startAt, timeMode)
        }))
      } : {
        ...editEntryForm,
        startAt: parseDateTimeInput(editEntryForm.startAt, timeMode),
        endAt: editEntryForm.endAt ? parseDateTimeInput(editEntryForm.endAt, timeMode) : null
      };
      await request(`/api/entries/${editingEntryId}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      cancelEditEntry();
      await loadWorkspace();
    }, 'Shift updated.');
  };

  const addDepartment = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/departments', { method: 'POST', body: JSON.stringify(newDepartment) });
      setNewDepartment(current => ({ name: '', requiredHours: 0, color: '#4a5568', teamId: current.teamId }));
      await loadWorkspace();
    }, 'Department added.');
  };
  const restoreDefaults = () => runAction(async () => {
    await request('/api/departments/defaults', { method: 'POST', body: JSON.stringify({}) });
    await loadWorkspace();
  }, 'Missing team defaults restored.');
  const saveDepartment = department => runAction(async () => {
    await request(`/api/departments/${department.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: department.name, requiredHours: department.requiredHours, color: department.color || '#4a5568', enabled: department.enabled !== false })
    });
    await loadWorkspace();
  }, 'Department updated.');
  const reorderDepartments = (departmentId, targetDepartmentId) => runAction(async () => {
    const index = departments.findIndex(department => department.id === departmentId);
    const targetIndex = departments.findIndex(department => department.id === targetDepartmentId);
    if (index < 0 || targetIndex < 0 || index === targetIndex) return;
    const ordered = [...departments];
    const [department] = ordered.splice(index, 1);
    ordered.splice(targetIndex, 0, department);
    await request('/api/departments/order', {
      method: 'PATCH',
      body: JSON.stringify({ departmentIds: ordered.map(department => department.id) })
    });
    await loadWorkspace();
  }, 'Department order updated.');
  const reorderTeams = (teamId, targetTeamId) => runAction(async () => {
    const index = teams.findIndex(team => team.id === teamId);
    const targetIndex = teams.findIndex(team => team.id === targetTeamId);
    if (index < 0 || targetIndex < 0 || index === targetIndex) return;
    const ordered = [...teams];
    const [team] = ordered.splice(index, 1);
    ordered.splice(targetIndex, 0, team);
    await request('/api/teams/order', {
      method: 'PATCH',
      body: JSON.stringify({ teamIds: ordered.map(item => item.id) })
    });
    await loadWorkspace();
  }, 'Team order updated.');
  const toggleDepartment = department => runAction(async () => {
    await request(`/api/departments/${department.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: department.name, requiredHours: department.requiredHours, color: department.color || '#4a5568', enabled: department.enabled === false })
    });
    await loadWorkspace();
  }, department.enabled === false ? 'Department enabled.' : 'Department disabled.');
  const deleteDepartment = department => {
    if (!window.confirm(`Delete "${department.name}" from your department list? Existing shift history will remain.`)) return;
    runAction(async () => {
      await request(`/api/departments/${department.id}`, { method: 'DELETE' });
      await loadWorkspace();
    }, 'Department removed.');
  };
  const addSubdivision = (event, departmentId) => {
    event.preventDefault();
    const subdivision = newSubdivisions[departmentId] || { name: '', requiredHours: 0 };
    runAction(async () => {
      await request(`/api/departments/${departmentId}/subdivisions`, {
        method: 'POST',
        body: JSON.stringify(subdivision)
      });
      setNewSubdivisions(current => ({ ...current, [departmentId]: { name: '', requiredHours: 0 } }));
      await loadWorkspace();
    }, 'Subdivision added.');
  };
  const saveSubdivision = (departmentId, subdivision) => runAction(async () => {
    await request(`/api/departments/${departmentId}/subdivisions/${subdivision.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: subdivision.name, requiredHours: subdivision.requiredHours, enabled: subdivision.enabled !== false })
    });
    await loadWorkspace();
  }, 'Subdivision updated.');
  const reorderSubdivisions = (departmentId, subdivisionId, targetSubdivisionId) => runAction(async () => {
    const department = departments.find(item => item.id === departmentId);
    const index = department?.subdivisions.findIndex(subdivision => subdivision.id === subdivisionId) ?? -1;
    const targetIndex = department?.subdivisions.findIndex(subdivision => subdivision.id === targetSubdivisionId) ?? -1;
    if (!department || index < 0 || targetIndex < 0 || index === targetIndex) return;
    const ordered = [...department.subdivisions];
    const [subdivision] = ordered.splice(index, 1);
    ordered.splice(targetIndex, 0, subdivision);
    await request(`/api/departments/${departmentId}/subdivisions/order`, {
      method: 'PATCH',
      body: JSON.stringify({ subdivisionIds: ordered.map(subdivision => subdivision.id) })
    });
    await loadWorkspace();
  }, 'Subdivision order updated.');
  const startDrag = (event, item) => {
    if (hasPendingStructureChanges) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    setDraggedItem(item);
  };
  const finishDrag = () => {
    setDraggedItem(null);
    setDragOverItem(null);
  };
  const dragOverDepartment = (event, departmentId) => {
    if (draggedItem?.type !== 'department' || draggedItem.id === departmentId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverItem({ type: 'department', id: departmentId });
  };
  const dragOverTeam = (event, teamId) => {
    if (draggedItem?.type !== 'team' || draggedItem.id === teamId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverItem({ type: 'team', id: teamId });
  };
  const dropTeam = (event, teamId) => {
    if (draggedItem?.type !== 'team' || draggedItem.id === teamId) return;
    event.preventDefault();
    reorderTeams(draggedItem.id, teamId);
    finishDrag();
  };
  const dropDepartment = (event, departmentId) => {
    if (draggedItem?.type !== 'department' || draggedItem.id === departmentId) return;
    event.preventDefault();
    reorderDepartments(draggedItem.id, departmentId);
    finishDrag();
  };
  const dragOverSubdivision = (event, departmentId, subdivisionId) => {
    if (draggedItem?.type !== 'subdivision' ||
      draggedItem.departmentId !== departmentId ||
      draggedItem.id === subdivisionId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDragOverItem({ type: 'subdivision', departmentId, id: subdivisionId });
  };
  const dropSubdivision = (event, departmentId, subdivisionId) => {
    if (draggedItem?.type !== 'subdivision' ||
      draggedItem.departmentId !== departmentId ||
      draggedItem.id === subdivisionId) return;
    event.preventDefault();
    event.stopPropagation();
    reorderSubdivisions(departmentId, draggedItem.id, subdivisionId);
    finishDrag();
  };
  const toggleSubdivision = (departmentId, subdivision) => runAction(async () => {
    await request(`/api/departments/${departmentId}/subdivisions/${subdivision.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: subdivision.name, requiredHours: subdivision.requiredHours, enabled: subdivision.enabled === false })
    });
    await loadWorkspace();
  }, subdivision.enabled === false ? 'Subdivision enabled.' : 'Subdivision disabled.');
  const deleteSubdivision = (department, subdivision) => {
    if (!window.confirm(`Delete "${subdivision.name}" from "${department.name}"?`)) return;
    runAction(async () => {
      await request(`/api/departments/${department.id}/subdivisions/${subdivision.id}`, { method: 'DELETE' });
      await loadWorkspace();
    }, 'Subdivision removed.');
  };

  const changePassword = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/auth/password', {
        method: 'PATCH',
        body: JSON.stringify(passwordForm)
      });
      setPasswordForm({ currentPassword: '', newPassword: '' });
    }, 'Password updated.');
  };
  const changeUsername = event => {
    event.preventDefault();
    runAction(async () => {
      const nextAuth = await request('/api/auth/username', {
        method: 'PATCH',
        body: JSON.stringify({ username: usernameForm })
      });
      localStorage.setItem(AUTH_KEY, JSON.stringify(nextAuth));
      onAuthUpdate(nextAuth);
      setUsernameForm(nextAuth.user.username);
    }, 'Username updated.');
  };
  const updateDojCallsign = (id, value) => setDojProfile(current => ({
    ...current,
    callsigns: { ...current.callsigns, [id]: value }
  }));
  const dojProfileHasChanges = JSON.stringify(dojProfile) !== JSON.stringify(savedDojProfile);
  const saveDojProfile = event => {
    event.preventDefault();
    runAction(async () => {
      const profile = await request('/api/auth/doj-profile', {
        method: 'PATCH',
        body: JSON.stringify(dojProfile)
      });
      setDojProfile(profile);
      setSavedDojProfile(profile);
    }, 'DOJ account options updated.');
  };
  const joinTeam = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/teams/join', {
        method: 'POST',
        body: JSON.stringify({ key: joinKey })
      });
      setJoinKey('');
      await loadWorkspace();
    }, 'Team joined.');
  };
  const toggleTeam = team => runAction(async () => {
    await request(`/api/teams/${team.id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: team.enabled === false })
    });
    await loadWorkspace();
  }, team.enabled === false ? 'Team enabled.' : 'Team disabled.');
  const leaveTeam = team => {
    if (!window.confirm(`Leave "${team.name}"? Its departments will be removed from your active workspace, but existing shift history will remain.`)) return;
    runAction(async () => {
      await request(`/api/teams/${team.id}/membership`, { method: 'DELETE' });
      await Promise.all([loadWorkspace(), loadUsers()]);
    }, 'Team left.');
  };
  const createUser = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/users', { method: 'POST', body: JSON.stringify(newUser) });
      setNewUser({ username: '', password: '', role: 'user', teamIds: [DOJ_TEAM_ID] });
      await Promise.all([loadUsers(), loadWorkspace()]);
    }, 'User created.');
  };
  const toggleRegistration = () => runAction(async () => {
    const settings = await request('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ allowRegistration: !registrationEnabled })
    });
    setRegistrationEnabled(settings.allowRegistration === true);
  }, registrationEnabled ? 'Public registration disabled.' : 'Public registration enabled.');
  const saveUser = user => runAction(async () => {
    const result = await request(`/api/users/${user.originalUsername}`, {
      method: 'PATCH',
      body: JSON.stringify({ username: user.username, role: user.role, password: user.pendingPassword || undefined, teamIds: user.teamIds })
    });
    if (result.token) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(result));
      onAuthUpdate(result);
    } else {
      await Promise.all([loadUsers(), loadWorkspace()]);
    }
  }, 'User updated.');
  const toggleUserTeam = (username, teamId) => setUsers(current => current.map(user => {
    if (user.originalUsername !== username) return user;
    const includes = user.teamIds.includes(teamId);
    const teamIds = includes ? user.teamIds.filter(id => id !== teamId) : [...user.teamIds, teamId];
    return { ...user, teamIds };
  }));
  const userHasChanges = user => user.username !== user.originalUsername || user.role !== user.originalRole || user.pendingPassword ||
    JSON.stringify(user.teamIds) !== JSON.stringify(user.originalTeamIds);
  const createTeam = event => {
    event.preventDefault();
    runAction(async () => {
      await request('/api/admin/teams', { method: 'POST', body: JSON.stringify(newTeam) });
      setNewTeam({ name: '', joinKey: '', lockDepartments: false, lockSubdivisions: false, personalized: false });
      await Promise.all([loadAdminTeams(), loadWorkspace(), loadUsers()]);
    }, 'Team created.');
  };
  const updateTeamDraft = (teamId, field, value) => setAdminTeams(current => current.map(team =>
    team.id === teamId ? {
      ...team,
      [field]: value,
      ...(field === 'personalized' && value ? { lockDepartments: false, lockSubdivisions: false } : {})
    } : team
  ));
  const saveTeamChanges = team => runAction(async () => {
    await request(`/api/admin/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify(team) });
    await Promise.all([loadAdminTeams(), loadWorkspace(), loadUsers()]);
  }, 'Team updated.');
  const teamHasChanges = team => ['name', 'joinKey', 'lockDepartments', 'lockSubdivisions', 'personalized']
    .some(field => team[field] !== team.original?.[field]);
  const deleteTeam = team => {
    if (!window.confirm(`Delete team "${team.name}"? Members will lose access to its departments.`)) return;
    runAction(async () => {
      await request(`/api/admin/teams/${team.id}`, { method: 'DELETE' });
      await Promise.all([loadAdminTeams(), loadWorkspace(), loadUsers()]);
    }, 'Team deleted.');
  };
  const deleteUser = user => {
    if (!window.confirm(`Delete user "${user.username}" and their Tracky data?`)) return;
    runAction(async () => {
      await request(`/api/users/${user.username}`, { method: 'DELETE' });
      await Promise.all([loadUsers(), loadActivePatrols()]);
    }, 'User deleted.');
  };

  return (
    <main className="control-panel">
      <header className="desk-header">
        <div>
          <p className="eyebrow">Operations Console</p>
          <h1>{APP_NAME} <span className="highlight">Time Control</span></h1>
          <p className="muted">{APP_DESC}</p>
        </div>
        <div className="session-actions">
          <span>{auth.user.username.toUpperCase()} / {auth.user.role.toUpperCase()}</span>
          <div className="time-mode-toggle" aria-label="Time display mode">
            <button type="button" className={timeMode === TIME_MODE_LOCAL ? 'btn-primary' : 'btn-toggle'} onClick={() => setClockMode(TIME_MODE_LOCAL)}>LOCAL</button>
            <button type="button" className={timeMode === TIME_MODE_ZULU ? 'btn-primary' : 'btn-toggle'} onClick={() => setClockMode(TIME_MODE_ZULU)}>ZULU</button>
          </div>
          <div className="time-mode-toggle" aria-label="Clock format">
            <button type="button" className={clockFormat === CLOCK_FORMAT_12 ? 'btn-primary' : 'btn-toggle'} onClick={() => setDisplayClockFormat(CLOCK_FORMAT_12)}>12H</button>
            <button type="button" className={clockFormat === CLOCK_FORMAT_24 ? 'btn-primary' : 'btn-toggle'} onClick={() => setDisplayClockFormat(CLOCK_FORMAT_24)}>24H</button>
          </div>
          <button className="btn-toggle" onClick={onLogout}>Sign Out</button>
        </div>
      </header>

      {(message || error) && (
        <div className={error ? 'notice error-notice' : 'notice'}>{error || message}</div>
      )}

      <div className="dashboard-grid">
        <CollapsiblePanel title="Active Department Patrol" defaultOpen className="clock-card">
          {activeEntry ? (
            <div className="active-shift">
              <p className="eyebrow">Patrol Active</p>
              <strong>{activeEntry.departmentName}</strong>
              <span>Current assignment: {assignmentName(currentPatrolSegment)}</span>
              <div className="clock-duration">{formatDuration(durationHours(activeEntry, now))}</div>
              <p className="muted">Started {formatDateTime(activeEntry.startAt, timeMode, clockFormat)}</p>
              {activeEntry.note && <p className="shift-note">{activeEntry.note}</p>}
              <div className="patrol-segments">
                {activePatrolSegments.map((segment, index) => (
                  <div className={!segment.endAt ? 'active' : ''} key={segment.id}>
                    <strong>{index + 1}. {assignmentName(segment)}</strong>
                    <small>{formatDateTime(segment.startAt, timeMode, clockFormat)} - {segment.endAt ? formatDateTime(segment.endAt, timeMode, clockFormat) : 'Active now'}</small>
                  </div>
                ))}
              </div>
              {(canSwitchToDepartmentOnly || selectablePatrolSubdivisions.length > 0) && (
                <form className="compact-form patrol-switch" onSubmit={activateSubdivision}>
                  <label>Switch Active Subdivision</label>
                  <select value={nextSubdivisionId} onChange={event => setNextSubdivisionId(event.target.value)}>
                    {canSwitchToDepartmentOnly && <option value="">{NO_SUBDIVISION_LABEL}</option>}
                    <SubdivisionOptions subdivisions={selectablePatrolSubdivisions} />
                  </select>
                  <button className="btn-primary">Switch Subdivision</button>
                </form>
              )}
              {usedPatrolSubdivisionIds.size >= 3 && (
                <p className="patrol-limit">Three subdivisions selected. You can switch among them, or end this patrol to select others.</p>
              )}
              <button className="btn-danger" onClick={clockOut}>End Patrol</button>
            </div>
          ) : (
            <form className="compact-form" onSubmit={createClockEntry}>
              <div className="form-group">
                <label>Department</label>
                <select value={clockForm.departmentId} onChange={event => setClockForm({
                  ...clockForm,
                  departmentId: event.target.value,
                  subdivisionId: ''
                })}>
                  <DepartmentOptions departments={activeDepartments} teams={teams} />
                </select>
              </div>
              <div className="form-group">
                <label>Subdivision</label>
                <select value={clockForm.subdivisionId} onChange={event => setClockForm({ ...clockForm, subdivisionId: event.target.value })}>
                  <option value="">{NO_SUBDIVISION_LABEL}</option>
                  <SubdivisionOptions subdivisions={clockDepartment?.subdivisions || []} />
                </select>
              </div>
              <div className="form-group">
                <label>Note</label>
                <input value={clockForm.note} onChange={event => setClockForm({ ...clockForm, note: event.target.value })} placeholder="Optional shift note" />
              </div>
              <button className="btn-success" disabled={!clockForm.departmentId}>Start Patrol</button>
            </form>
          )}
        </CollapsiblePanel>

        <CollapsiblePanel
          title="Monthly Status"
          className="progress-card"
          headerExtra={(
            <div className="panel-total">
              <strong>Total tracked</strong>
              <ProgressBar worked={totalWorked} required={totalRequired} />
            </div>
          )}
        >
          <p className="week-range">{currentMonth.label}. Resets on the first of the month.</p>
          <div className="progress-list">
            {progress.map(department => (
              <details key={department.id}>
                <summary>
                  <span>{department.name}</span>
                  <ProgressBar worked={department.worked} required={Number(department.requiredHours)} />
                </summary>
                {department.subdivisions.map(subdivision => (
                  <div className="sub-progress" key={subdivision.id}>
                    <span>{subdivision.name}</span>
                    <ProgressBar worked={subdivision.worked} required={Number(subdivision.requiredHours)} />
                  </div>
                ))}
              </details>
            ))}
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel title="Shift Log" className="activity-card">
          <form className="compact-form manual-form" onSubmit={addManualEntry}>
            <h3>Add Completed Shift</h3>
            <div className="form-row">
              <div className="form-group">
                <label>Department</label>
                <select value={manualForm.departmentId} onChange={event => setManualForm({
                  ...manualForm,
                  departmentId: event.target.value,
                  subdivisionId: ''
                })}>
                  <DepartmentOptions departments={activeDepartments} teams={teams} />
                </select>
              </div>
              <div className="form-group">
                <label>Subdivision</label>
                <select value={manualForm.subdivisionId} onChange={event => setManualForm({ ...manualForm, subdivisionId: event.target.value })}>
                  <option value="">{NO_SUBDIVISION_LABEL}</option>
                  <SubdivisionOptions subdivisions={manualDepartment?.subdivisions || []} />
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Clock In</label>
                <input type="datetime-local" value={manualForm.startAt} onChange={event => setManualForm({ ...manualForm, startAt: event.target.value })} required />
              </div>
              <div className="form-group">
                <label>Clock Out</label>
                <input type="datetime-local" value={manualForm.endAt} onChange={event => setManualForm({ ...manualForm, endAt: event.target.value })} required />
              </div>
            </div>
            <div className="form-group">
              <label>Note</label>
              <input value={manualForm.note} onChange={event => setManualForm({ ...manualForm, note: event.target.value })} placeholder="Optional note" />
            </div>
            <button className={manualForm.departmentId ? 'btn-primary' : 'btn-toggle'} disabled={!manualForm.departmentId}>Add Shift</button>
          </form>
          <div className="log-filters">
            <div className="form-group">
              <label>Month</label>
              <select value={logMonthFilter} onChange={event => setLogMonthFilter(event.target.value)}>
                <option value={LOG_MONTH_ALL}>All time</option>
                {availableLogMonths.map(key => (
                  <option key={key} value={key}>{monthLabel(key, timeMode)}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Department</label>
              <select value={logDepartmentFilter} onChange={event => setLogDepartmentFilter(event.target.value)}>
                <option value="">All departments</option>
                <DepartmentOptions departments={logDepartmentOptions.filter(department => department.teamId)} teams={teams} />
                {historicalDepartments.map(department => (
                  <option key={department.id} value={department.id}>{department.name} (historical)</option>
                ))}
              </select>
            </div>
          </div>
          <div className="entry-list">
            {filteredLogEntries.length === 0 && <p className="empty-text">No patrols recorded for the selected filters.</p>}
            {filteredLogEntries.slice(0, 50).map(entry => (
              <div
                className={`entry-row ${!entry.endAt ? 'open' : ''}`}
                key={entry.id}
                style={{ borderLeftColor: departmentColorFor(entry) }}
              >
                {editingEntryId === entry.id ? (
                  <form className="entry-edit-form" onSubmit={saveEntry}>
                    <div className="form-row">
                      <div className="form-group">
                        <label>Department</label>
                        <select value={editEntryForm.departmentId} onChange={event => setEditEntryForm({
                          ...editEntryForm,
                          departmentId: event.target.value,
                          subdivisionId: '',
                          segments: editEntryForm.segments?.map(segment => ({ ...segment, subdivisionId: '' }))
                        })}>
                          <DepartmentOptions departments={editDepartmentOptions} teams={teams} />
                        </select>
                      </div>
                      {!editingMultipleSegments && <div className="form-group">
                        <label>Subdivision</label>
                        <select value={editEntryForm.subdivisionId} onChange={event => setEditEntryForm({ ...editEntryForm, subdivisionId: event.target.value })}>
                          <option value="">{NO_SUBDIVISION_LABEL}</option>
                          <SubdivisionOptions subdivisions={editSubdivisionOptions} />
                        </select>
                      </div>}
                    </div>
                    {editingMultipleSegments ? (
                      <div className="segment-edit-list">
                        {editEntryForm.segments.map((segment, index) => (
                          <div className="form-row segment-edit-row" key={segment.id}>
                            <div className="form-group">
                              <label>Assignment {index + 1}</label>
                              <select value={segment.subdivisionId} onChange={event => setEditEntryForm({
                                ...editEntryForm,
                                segments: editEntryForm.segments.map(item => item.id === segment.id
                                  ? { ...item, subdivisionId: event.target.value }
                                  : item)
                              })}>
                                <option value="">{NO_SUBDIVISION_LABEL}</option>
                                <SubdivisionOptions subdivisions={editSegmentSubdivisionOptions(segment.subdivisionId)} />
                              </select>
                            </div>
                            <div className="form-group">
                              <label>Starts At</label>
                              <input type="datetime-local" value={segment.startAt} onChange={event => setEditEntryForm({
                                ...editEntryForm,
                                segments: editEntryForm.segments.map((item, itemIndex) => {
                                  if (item.id === segment.id) return { ...item, startAt: event.target.value };
                                  if (itemIndex === index - 1) return { ...item, endAt: event.target.value };
                                  return item;
                                })
                              })} step="0.001" required />
                            </div>
                            <div className="form-group">
                              <label>Ends At</label>
                              <input type="datetime-local" value={segment.endAt} onChange={event => {
                                const nextValue = event.target.value;
                                setEditEntryForm({
                                  ...editEntryForm,
                                  endAt: index === editEntryForm.segments.length - 1 ? nextValue : editEntryForm.endAt,
                                  segments: editEntryForm.segments.map((item, itemIndex) => {
                                    if (item.id === segment.id) return { ...item, endAt: nextValue };
                                    if (itemIndex === index + 1) return { ...item, startAt: nextValue };
                                    return item;
                                  })
                                });
                              }} step="0.001" required={index < editEntryForm.segments.length - 1 || Boolean(editEntryForm.endAt)} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="form-row">
                        <div className="form-group">
                          <label>Clock In</label>
                          <input type="datetime-local" value={editEntryForm.startAt} onChange={event => setEditEntryForm({ ...editEntryForm, startAt: event.target.value })} required />
                        </div>
                        <div className="form-group">
                          <label>Clock Out</label>
                          <input type="datetime-local" value={editEntryForm.endAt} onChange={event => setEditEntryForm({ ...editEntryForm, endAt: event.target.value })} />
                        </div>
                      </div>
                    )}
                    {editingEntry?.endAt && missedSubdivisionOptions.length > 0 && (
                      <div className="entry-edit-add">
                        <button type="button" className="btn-toggle" onClick={addMissedSubdivision}>Add Missed Subdivision</button>
                        <small>Adjust its start time to assign time from the previous activity.</small>
                      </div>
                    )}
                    <div className="form-group">
                      <label>Note</label>
                      <input value={editEntryForm.note} onChange={event => setEditEntryForm({ ...editEntryForm, note: event.target.value })} placeholder="Optional note" />
                    </div>
                    <div className="entry-edit-actions">
                      <button type="submit" className={JSON.stringify(editEntryForm) !== JSON.stringify(originalEditEntryForm) ? 'btn-primary' : 'btn-toggle'}>Save Changes</button>
                      <button type="button" className="btn-toggle" onClick={cancelEditEntry}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="entry-summary">
                      <strong>{departmentNameFor(entry)}</strong>
                      <small>{formatDateTime(entry.startAt, timeMode, clockFormat)} - {entry.endAt ? formatDateTime(entry.endAt, timeMode, clockFormat) : 'Active now'}</small>
                      {entry.note && <small>{entry.note}</small>}
                      <div className="entry-segments">
                        {groupedEntryAssignments(entry).map(assignment => (
                          <small key={assignment.subdivisionId || '__department_only__'}>
                            {assignment.name}: {formatDuration(assignment.worked)}
                          </small>
                        ))}
                      </div>
                    </div>
                    <div className="entry-hours">
                      <strong>{formatDuration(durationHours(entry, now))}</strong>
                      <div className="entry-actions">
                        {canFileDojEntry(entry) && (
                          <button type="button" className={entry.formGeneratedAt ? 'btn-toggle' : 'btn-primary'} onClick={() => fileLog(entry)}>File Log</button>
                        )}
                        {canResumeEntry(entry) && (
                          <button type="button" className="btn-primary" disabled={Boolean(activeEntry)} onClick={() => resumeEntry(entry)}>Resume</button>
                        )}
                        <button type="button" className="btn-toggle" onClick={() => startEditEntry(entry)}>Edit</button>
                        <button type="button" className="btn-delete" onClick={() => deleteEntry(entry)}>Delete</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel title="Departments and Activity" className="structure-card">
          <button type="button" className="btn-toggle structure-restore" onClick={restoreDefaults}>Restore Missing Team Defaults</button>
          <p className="muted">Your monthly hour targets, visibility toggles, and colors remain personal. Team permissions determine whether department and subdivision structure can be edited.</p>
          <form className="compact-form new-department-form" onSubmit={addDepartment}>
            <h3>New Department</h3>
            <div className="form-row">
              <div className="form-group">
                <label>Team</label>
                <select value={newDepartment.teamId} onChange={event => setNewDepartment({ ...newDepartment, teamId: event.target.value })}>
                  {editableDepartmentTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </div>
              <div className="form-group wide">
                <label>Name</label>
                <input value={newDepartment.name} onChange={event => setNewDepartment({ ...newDepartment, name: event.target.value })} required />
              </div>
              <div className="form-group hours-field">
                <label>Monthly Hours</label>
                <input type="number" min="0" max="744" step="0.25" value={newDepartment.requiredHours} onChange={event => setNewDepartment({ ...newDepartment, requiredHours: event.target.value })} />
              </div>
              <div className="form-group color-field">
                <label>Color</label>
                <input type="color" value={newDepartment.color} onChange={event => setNewDepartment({ ...newDepartment, color: event.target.value })} aria-label="New department shift log color" />
              </div>
              <button className={`${newDepartment.name.trim() ? 'btn-primary' : 'btn-toggle'} action-align`}>Add Department</button>
            </div>
          </form>
          <div className="department-grid">
            {departmentGroups.map(team => (
              <details
                className={`team-department-group ${team.enabled === false ? 'disabled-team' : ''} ${dragOverItem?.type === 'team' && dragOverItem.id === team.id ? 'drag-over' : ''}`}
                key={team.id}
                open={expandedTeams[team.id] !== false}
                onToggle={event => {
                  const open = event.currentTarget.open;
                  setExpandedTeams(current => ({ ...current, [team.id]: open }));
                }}
                onDragOver={event => dragOverTeam(event, team.id)}
                onDrop={event => dropTeam(event, team.id)}
              >
                <summary className="team-department-heading">
                  <span
                    className="drag-handle"
                    draggable={!hasPendingStructureChanges}
                    aria-label={`Reorder ${team.name}`}
                    title="Drag to reorder team"
                    onClick={event => event.preventDefault()}
                    onDragStart={event => startDrag(event, { type: 'team', id: team.id })}
                    onDragEnd={finishDrag}
                  >
                    <span className="drag-handle-dots" aria-hidden="true" />
                  </span>
                  <strong className="team-title">{team.name}</strong>
                  <small>{team.personalized ? 'Personalised' : [
                    team.lockDepartments ? 'Department editing locked' : '',
                    team.lockSubdivisions ? 'Subdivision editing locked' : ''
                  ].filter(Boolean).join(' / ') || 'Structure editable'}</small>
                  {team.id !== PERSONAL_TEAM_ID && (
                    <button
                      type="button"
                      className={team.enabled === false ? 'btn-primary' : 'btn-toggle'}
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleTeam(team);
                      }}
                    >
                      {team.enabled === false ? 'Enable' : 'Disable'}
                    </button>
                  )}
                </summary>
                {team.departments.length === 0 && <p className="empty-text">No departments in this team.</p>}
                {team.departments.map(department => {
              const draft = newSubdivisions[department.id] || { name: '', requiredHours: 0 };
              return (
                <details
                  className={`department-editor ${department.enabled === false ? 'disabled-item' : ''} ${dragOverItem?.type === 'department' && dragOverItem.id === department.id ? 'drag-over' : ''}`}
                  key={department.id}
                  onDragOver={event => dragOverDepartment(event, department.id)}
                  onDrop={event => dropDepartment(event, department.id)}
                >
                  <summary>
                    <span
                      className="drag-handle"
                      draggable={!hasPendingStructureChanges && department.canEditDepartments}
                      aria-label={`Reorder ${department.name}`}
                      title="Drag to reorder"
                      onClick={event => event.preventDefault()}
                      onDragStart={event => startDrag(event, { type: 'department', id: department.id })}
                      onDragEnd={finishDrag}
                    >
                      <span className="drag-handle-dots" aria-hidden="true" />
                    </span>
                    <span className="department-title">{department.name}</span>
                    <span className="department-count">{department.enabled === false ? 'Disabled / ' : ''}{department.subdivisions.length} subdivisions</span>
                  </summary>
                  <div className="department-fields">
                    <span className="drag-spacer" aria-hidden="true" />
                    <input value={department.name} disabled={!department.canEditDepartments} onChange={event => updateDepartmentDraft(department.id, 'name', event.target.value)} />
                    <input type="number" min="0" max="744" step="0.25" value={department.requiredHours} onChange={event => updateDepartmentDraft(department.id, 'requiredHours', event.target.value)} aria-label="Monthly department hours" />
                    <input type="color" value={department.color || '#4a5568'} onChange={event => updateDepartmentDraft(department.id, 'color', event.target.value)} aria-label={`${department.name} shift log color`} />
                    <button type="button" className={departmentHasChanges(department) ? 'btn-primary' : 'btn-toggle'} onClick={() => saveDepartment(department)}>Save</button>
                    <button type="button" disabled={hasPendingStructureChanges} className={department.enabled === false ? 'btn-primary' : 'btn-toggle'} onClick={() => toggleDepartment(department)}>{department.enabled === false ? 'Enable' : 'Disable'}</button>
                    {department.canEditDepartments && <button type="button" className="btn-delete" onClick={() => deleteDepartment(department)}>Delete</button>}
                  </div>
                  <div className="subdivision-list">
                    {department.subdivisions.map((subdivision, index) => (
                      <React.Fragment key={subdivision.id}>
                        {subdivision.group && department.subdivisions[index - 1]?.group !== subdivision.group && (
                          <div className="subdivision-divider">{subdivision.group}</div>
                        )}
                        <div
                          className={`subdivision-row ${subdivision.enabled === false ? 'disabled-item' : ''} ${dragOverItem?.type === 'subdivision' && dragOverItem.id === subdivision.id ? 'drag-over' : ''}`}
                          onDragOver={event => dragOverSubdivision(event, department.id, subdivision.id)}
                          onDrop={event => dropSubdivision(event, department.id, subdivision.id)}
                        >
                          <span
                            className="drag-handle"
                            draggable={!hasPendingStructureChanges && department.canEditSubdivisions}
                            aria-label={`Reorder ${subdivision.name}`}
                            title="Drag to reorder"
                            onDragStart={event => startDrag(event, { type: 'subdivision', departmentId: department.id, id: subdivision.id })}
                            onDragEnd={finishDrag}
                          >
                            <span className="drag-handle-dots" aria-hidden="true" />
                          </span>
                          <input value={subdivision.name} disabled={!department.canEditSubdivisions} onChange={event => updateSubdivisionDraft(department.id, subdivision.id, 'name', event.target.value)} />
                          <input type="number" min="0" max="744" step="0.25" value={subdivision.requiredHours} onChange={event => updateSubdivisionDraft(department.id, subdivision.id, 'requiredHours', event.target.value)} aria-label="Monthly subdivision hours" />
                          <button type="button" className={subdivisionHasChanges(department.id, subdivision) ? 'btn-primary' : 'btn-toggle'} onClick={() => saveSubdivision(department.id, subdivision)}>Save</button>
                          <button type="button" disabled={hasPendingStructureChanges} className={subdivision.enabled === false ? 'btn-primary' : 'btn-toggle'} onClick={() => toggleSubdivision(department.id, subdivision)}>{subdivision.enabled === false ? 'Enable' : 'Disable'}</button>
                          {department.canEditSubdivisions && <button type="button" className="btn-delete" onClick={() => deleteSubdivision(department, subdivision)}>Delete</button>}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                  {department.canEditSubdivisions && <form className="subdivision-row add-subdivision" onSubmit={event => addSubdivision(event, department.id)}>
                    <input placeholder="New subdivision" value={draft.name} onChange={event => setNewSubdivisions({
                      ...newSubdivisions,
                      [department.id]: { ...draft, name: event.target.value }
                    })} required />
                    <input type="number" min="0" max="744" step="0.25" value={draft.requiredHours} onChange={event => setNewSubdivisions({
                      ...newSubdivisions,
                      [department.id]: { ...draft, requiredHours: event.target.value }
                    })} aria-label="New subdivision monthly hours" />
                    <button className={draft.name.trim() ? 'btn-primary' : 'btn-toggle'}>Add</button>
                  </form>}
                </details>
              );
            })}
              </details>
            ))}
          </div>
        </CollapsiblePanel>

        {auth.user.role === 'admin' && (
          <CollapsiblePanel title="Active Patrols">
            <p className="muted">Current department patrols across all users. This list refreshes automatically.</p>
            <div className="entry-list">
              {activePatrols.length === 0 && <p className="empty-text">No users currently have an active patrol.</p>}
              {activePatrols.map(patrol => (
                <div className="entry-row open" key={patrol.entryId}>
                  <div className="entry-summary">
                    <strong>{patrol.username}</strong>
                    <small>{patrol.departmentName} / {patrol.subdivisionName || 'Department only'}</small>
                    <small>Started {formatDateTime(patrol.startAt, timeMode, clockFormat)}</small>
                  </div>
                  <div className="entry-hours">
                    <strong>{formatDuration(durationHours(patrol, now))}</strong>
                    <small>Total patrol duration</small>
                  </div>
                </div>
              ))}
            </div>
          </CollapsiblePanel>
        )}

        <CollapsiblePanel title="My Account" className="account-card">
          <form className="compact-form" onSubmit={changeUsername}>
            <div className="form-group">
              <label>Username</label>
              <input value={usernameForm} onChange={event => setUsernameForm(event.target.value)} required />
            </div>
            <button className={usernameForm !== auth.user.username ? 'btn-primary' : 'btn-toggle'}>Update Username</button>
          </form>
          <form className="compact-form" onSubmit={changePassword}>
            <div className="form-group">
              <label>Current Password</label>
              <input type="password" value={passwordForm.currentPassword} onChange={event => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} required />
            </div>
            <div className="form-group">
              <label>New Password</label>
              <input type="password" minLength="6" value={passwordForm.newPassword} onChange={event => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} required />
            </div>
            <button className={passwordForm.currentPassword && passwordForm.newPassword ? 'btn-primary' : 'btn-toggle'}>Update Password</button>
          </form>
          <form className="compact-form" onSubmit={joinTeam}>
            <h3>Join A Team</h3>
            <div className="form-row">
              <div className="form-group wide">
                <label>Team Key</label>
                <input value={joinKey} onChange={event => setJoinKey(event.target.value)} placeholder="Enter a team key" required />
              </div>
              <button className={joinKey.trim() ? 'btn-primary action-align' : 'btn-toggle action-align'}>Join Team</button>
            </div>
          </form>
          <section className="compact-form active-teams">
            <h3>Active Teams</h3>
            <div className="active-team-list">
              {teams.map(team => (
                <div className={`active-team-row ${team.enabled === false ? 'disabled-team-row' : ''}`} key={team.id}>
                  <div>
                    <strong>{team.name}</strong>
                    <small>{team.id === PERSONAL_TEAM_ID ? 'Always available' : team.enabled === false ? 'Disabled in your view' : 'Enabled in your view'}</small>
                  </div>
                  {team.id !== PERSONAL_TEAM_ID && (
                    <div className="active-team-actions">
                      <button type="button" className={team.enabled === false ? 'btn-primary' : 'btn-toggle'} onClick={() => toggleTeam(team)}>
                        {team.enabled === false ? 'Enable' : 'Disable'}
                      </button>
                      <button type="button" className="btn-delete" onClick={() => leaveTeam(team)}>Leave</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
          {isDojMember && (
            <details className="compact-form doj-options">
              <summary>
                <h3>DOJ Account Options</h3>
                <small>Community name and callsigns</small>
              </summary>
              <form className="doj-profile-form" onSubmit={saveDojProfile}>
                <div className="form-group">
                  <label>Community Name</label>
                  <input
                    value={dojProfile.communityName}
                    onChange={event => setDojProfile({ ...dojProfile, communityName: event.target.value })}
                    placeholder="Cleo M."
                    pattern="[A-Za-z][A-Za-z'-]* [A-Za-z]\."
                    title="Use First Name and Last Initial followed by a period, for example Cleo M."
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Email Address</label>
                    <input type="email" value={dojProfile.email} onChange={event => setDojProfile({ ...dojProfile, email: event.target.value })} placeholder="Optional email address" />
                  </div>
                  <div className="form-group">
                    <label>Website ID</label>
                    <input value={dojProfile.websiteId} onChange={event => setDojProfile({ ...dojProfile, websiteId: event.target.value })} placeholder="Optional website ID" />
                  </div>
                </div>
                {hasVisibleSid && (
                  <div className="form-row">
                    <div className="form-group">
                      <label>IDN</label>
                      <input value={dojProfile.idn} onChange={event => setDojProfile({ ...dojProfile, idn: event.target.value })} placeholder="Optional IDN" />
                    </div>
                    <div className="form-group">
                      <label>Investigator Rank</label>
                      <input value={dojProfile.investigatorRank} onChange={event => setDojProfile({ ...dojProfile, investigatorRank: event.target.value })} placeholder="Optional investigator rank" />
                    </div>
                  </div>
                )}
                {hasVisibleBcso && (
                  <div className="form-group">
                    <label>BCSO Rank</label>
                    <select value={dojProfile.bcsoRank} onChange={event => setDojProfile({ ...dojProfile, bcsoRank: event.target.value })}>
                      <option value="">No rank selected</option>
                      {BCSO_RANKS.map(rank => <option key={rank} value={rank}>{rank}</option>)}
                    </select>
                  </div>
                )}
                <div className="doj-callsign-list">
                  {visibleDojDepartments.length === 0 && (
                    <p className="empty-text">Enable a DOJ department to configure its callsigns.</p>
                  )}
                  {visibleDojDepartments.map(department => (
                    <section className="doj-callsign-group" key={department.id}>
                      <h4>{department.name}</h4>
                      <div className="form-group">
                        <label>Department Only Callsign</label>
                        <input value={dojProfile.callsigns[department.id] || ''} onChange={event => updateDojCallsign(department.id, event.target.value)} placeholder="Optional callsign" />
                      </div>
                      {department.subdivisions.filter(subdivision => subdivision.enabled !== false).map(subdivision => (
                        <div className="form-group" key={subdivision.id}>
                          <label>{subdivision.name} Callsign</label>
                          <input value={dojProfile.callsigns[subdivision.id] || ''} onChange={event => updateDojCallsign(subdivision.id, event.target.value)} placeholder="Optional callsign" />
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
                <button className={dojProfileHasChanges ? 'btn-primary' : 'btn-toggle'}>Save DOJ Options</button>
              </form>
            </details>
          )}
        </CollapsiblePanel>

        {auth.user.role === 'admin' && (
          <div className="admin-management-grid">
          <CollapsiblePanel title="User Management" className="admin-card user-admin-card" open={adminPanelsOpen} onOpenChange={setAdminPanelsOpen}>
            <section className="compact-form registration-settings">
              <div>
                <h3>Public Registration</h3>
                <p className="muted">Allow users to create an account from the sign-in page and optionally enter a team key.</p>
              </div>
              <button
                type="button"
                className={registrationEnabled ? 'btn-toggle' : 'btn-primary'}
                onClick={toggleRegistration}
              >
                {registrationEnabled ? 'Disable Registration' : 'Enable Registration'}
              </button>
            </section>
            <form className="compact-form" onSubmit={createUser}>
              <h3>Create User</h3>
              <div className="form-row">
                <div className="form-group">
                  <label>Username</label>
                  <input value={newUser.username} onChange={event => setNewUser({ ...newUser, username: event.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Temporary Password</label>
                  <input type="password" minLength="6" value={newUser.password} onChange={event => setNewUser({ ...newUser, password: event.target.value })} required />
                </div>
                <div className="form-group role-field">
                  <label>Role</label>
                  <select value={newUser.role} onChange={event => setNewUser({ ...newUser, role: event.target.value })}>
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                  </select>
                </div>
              </div>
              <div className="team-checkbox-list">
                {adminTeams.map(team => (
                  <label key={team.id}>
                    <input
                      type="checkbox"
                      checked={newUser.teamIds.includes(team.id)}
                      onChange={() => setNewUser(current => ({
                        ...current,
                        teamIds: current.teamIds.includes(team.id)
                          ? current.teamIds.filter(id => id !== team.id)
                          : [...current.teamIds, team.id]
                      }))}
                    />
                    {team.name}
                  </label>
                ))}
              </div>
              <button className={newUser.username.trim() && newUser.password ? 'btn-primary' : 'btn-toggle'}>Create User</button>
            </form>
            <div className="user-list">
              {users.map(user => (
                <div className="user-row" key={user.originalUsername}>
                  <input value={user.username} aria-label={`${user.originalUsername} username`} onChange={event => setUsers(current => current.map(item =>
                    item.originalUsername === user.originalUsername ? { ...item, username: event.target.value } : item
                  ))} />
                  <select value={user.role} onChange={event => setUsers(current => current.map(item =>
                    item.originalUsername === user.originalUsername ? { ...item, role: event.target.value } : item
                  ))}>
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                  </select>
                  <input type="password" placeholder="New password (optional)" value={user.pendingPassword} onChange={event => setUsers(current => current.map(item =>
                    item.originalUsername === user.originalUsername ? { ...item, pendingPassword: event.target.value } : item
                  ))} />
                  <div className="team-checkbox-list user-teams">
                    {adminTeams.map(team => (
                      <label key={team.id}>
                        <input type="checkbox" checked={user.teamIds.includes(team.id)} onChange={() => toggleUserTeam(user.originalUsername, team.id)} />
                        {team.name}
                      </label>
                    ))}
                  </div>
                  <button className={userHasChanges(user) ? 'btn-primary' : 'btn-toggle'} onClick={() => saveUser(user)}>Save</button>
                  <button className="btn-delete" disabled={user.originalUsername === auth.user.username} onClick={() => deleteUser({ ...user, username: user.originalUsername })}>Delete</button>
                </div>
              ))}
            </div>
          </CollapsiblePanel>
          <CollapsiblePanel title="Team Management" className="admin-card team-admin-card" open={adminPanelsOpen} onOpenChange={setAdminPanelsOpen}>
            <form className="compact-form" onSubmit={createTeam}>
              <h3>Create Team</h3>
              <div className="form-row">
                <div className="form-group">
                  <label>Name</label>
                  <input value={newTeam.name} onChange={event => setNewTeam({ ...newTeam, name: event.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Join Key</label>
                  <input value={newTeam.joinKey} onChange={event => setNewTeam({ ...newTeam, joinKey: event.target.value })} required />
                </div>
              </div>
              <div className="permission-options">
                <label><input type="checkbox" checked={newTeam.personalized} onChange={event => setNewTeam({
                  ...newTeam,
                  personalized: event.target.checked,
                  ...(event.target.checked ? { lockDepartments: false, lockSubdivisions: false } : {})
                })} /> Personalised Team</label>
                <label><input type="checkbox" disabled={newTeam.personalized} checked={newTeam.lockDepartments} onChange={event => setNewTeam({ ...newTeam, lockDepartments: event.target.checked })} /> Lock department editing to admin</label>
                <label><input type="checkbox" disabled={newTeam.personalized} checked={newTeam.lockSubdivisions} onChange={event => setNewTeam({ ...newTeam, lockSubdivisions: event.target.checked })} /> Lock subdivision editing to admin</label>
              </div>
              <button className={newTeam.name.trim() && newTeam.joinKey.trim() ? 'btn-primary' : 'btn-toggle'}>Create Team</button>
            </form>
            <div className="team-management-list">
              {adminTeams.map(team => (
                <div className="team-management-row" key={team.id}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Name</label>
                      <input value={team.name} onChange={event => updateTeamDraft(team.id, 'name', event.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>Join Key</label>
                      <input value={team.joinKey} onChange={event => updateTeamDraft(team.id, 'joinKey', event.target.value)} />
                    </div>
                  </div>
                  <div className="permission-options">
                    <label><input type="checkbox" disabled={team.protected} checked={team.personalized} onChange={event => updateTeamDraft(team.id, 'personalized', event.target.checked)} /> Personalised Team</label>
                    <label><input type="checkbox" disabled={team.protected || team.personalized} checked={team.lockDepartments} onChange={event => updateTeamDraft(team.id, 'lockDepartments', event.target.checked)} /> Lock department editing to admin</label>
                    <label><input type="checkbox" disabled={team.protected || team.personalized} checked={team.lockSubdivisions} onChange={event => updateTeamDraft(team.id, 'lockSubdivisions', event.target.checked)} /> Lock subdivision editing to admin</label>
                  </div>
                  <div className="team-management-actions">
                    <button type="button" className={teamHasChanges(team) ? 'btn-primary' : 'btn-toggle'} onClick={() => saveTeamChanges(team)}>Save</button>
                    {!team.protected && <button type="button" className="btn-delete" onClick={() => deleteTeam(team)}>Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          </CollapsiblePanel>
          </div>
        )}
      </div>
    </main>
  );
}

function App() {
  const [auth, setAuth] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY)) || null;
    } catch (error) {
      return null;
    }
  });

  const logout = () => {
    localStorage.removeItem(AUTH_KEY);
    setAuth(null);
  };

  return auth ? <Dashboard auth={auth} onLogout={logout} onAuthUpdate={setAuth} /> : <Login onLogin={setAuth} />;
}

export default App;

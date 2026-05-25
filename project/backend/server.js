const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createClient } = require('redis');

const app = express();
app.use(express.json({ limit: '200kb' }));

const PORTABLE_MODE = process.env.TRACKY_PORTABLE === '1' || Boolean(process.pkg);
const PORT = parseInt(process.env.PORT || (PORTABLE_MODE ? '8765' : '3000'), 10);
const HOST = process.env.HOST || (PORTABLE_MODE ? '127.0.0.1' : undefined);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TOKEN_SECRET = process.env.AUTH_SECRET || 'tracky-development-secret-change-me';
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const LOCAL_DATA_FILE = process.env.TRACKY_DATA_FILE ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Tracky', 'data.json');
const STATIC_DIR = process.env.TRACKY_STATIC_DIR ||
  (PORTABLE_MODE ? path.join(path.dirname(process.execPath), 'web') : '');
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const PATROL_RESUME_WINDOW_MS = 5 * 60 * 1000;
const USERS_INDEX_KEY = 'tracky:users:index';
const TEAMS_INDEX_KEY = 'tracky:teams:index';
const SETTINGS_KEY = 'tracky:settings';
const PERSONAL_TEAM_ID = 'personal';
const PERSONAL_TEAM_NAME = 'Personal Departments';
const DOJ_TEAM_ID = 'doj';
const CURRENT_CATALOG_VERSION = '2026-05-doj-profile-v2';
const DOJ_CATALOG_VERSION = '2026-05-gruppe-sechs-v4';
const BCSO_RANKS = [
  'Probationary Reserve Deputy', 'Reserve Deputy', 'Senior Reserve Deputy', 'Probationary Deputy',
  'Deputy I', 'Deputy II', 'Deputy III', 'Senior Deputy', 'Master Deputy', 'Corporal',
  'Senior Corporal', 'Sergeant', 'Staff Sergeant', 'Master Sergeant', 'Lieutenant', 'Captain',
  'Sheriff Major', 'Sheriff Commander', 'Sheriff Colonel'
];
const DOJ_FORM_CONFIGS = {
  'civilian-department': {
    type: 'civilian',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSfSfEPLCe05DXIv2Jks2BIzIG4tkeRkXgafqGe9QMt8TSICdA/viewform'
  },
  'los-santos-police-department': {
    type: 'lspd',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSe-C26eG0eMZXtr33hmpTC0bBChBiL2h-XPZ775Y0uIn24yNA/viewform'
  },
  'san-andreas-highway-patrol': {
    type: 'sahp',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSfaXvvG36o9DJtSH2Qe6t7w4bLYXIwVeOWt_zZT7sYRQOHn7A/viewform'
  },
  'blaine-county-sheriff-s-office': {
    type: 'bcso',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSecJZZIkatFAGCOrKws0HvTLJfVfLiTT9vcs3EyWjt8NpA_Vw/viewform'
  },
  'communications-department': {
    type: 'communications',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSdTpOKPlM8ELSyer4Q_tQdQmvjKrr_xcWn0ANVKGY0ldUOXrw/viewform'
  },
  'los-santos-fire-department': {
    type: 'fire',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSfl2kiAiZONQJTjTmtmYgWsxGK6iJxNJXiQ15x4KCWida9A2g/viewform'
  }
};
const loginAttempts = new Map();

const configuredAccessUrls = String(process.env.ACCESS_URL || process.env.CORS_ORIGINS || '').trim();
const allowAllOrigins = !configuredAccessUrls || configuredAccessUrls === '*';
const allowedOrigins = configuredAccessUrls
  .split(',')
  .map(value => value.trim())
  .filter(value => value && value !== '*');

const getHostname = (value) => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch (error) {
    return '';
  }
};
const isAllowedOrigin = (req) => {
  const origin = req.headers.origin;
  return allowAllOrigins ||
    !origin ||
    allowedOrigins.includes(origin) ||
    getHostname(origin) === getHostname(req.headers.host || '');
};
app.use((req, res, next) => {
  if (!isAllowedOrigin(req)) return res.status(403).json({ error: 'Origin not allowed.' });
  next();
});
app.use(cors((req, callback) => callback(null, { origin: allowAllOrigins || isAllowedOrigin(req) })));

const createLocalDataClient = filePath => {
  let data = { strings: {}, hashes: {}, sets: {} };
  let writes = Promise.resolve();
  const write = () => {
    const snapshot = JSON.stringify(data, null, 2);
    writes = writes.then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const temporaryFile = `${filePath}.tmp`;
      await fs.promises.writeFile(temporaryFile, snapshot, 'utf8');
      await fs.promises.rename(temporaryFile, filePath);
    });
    return writes;
  };
  const contains = key => ['strings', 'hashes', 'sets'].some(bucket =>
    Object.prototype.hasOwnProperty.call(data[bucket], key)
  );
  return {
    on: () => {},
    connect: async () => {
      try {
        const stored = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        data = {
          strings: stored.strings || {},
          hashes: stored.hashes || {},
          sets: stored.sets || {}
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
    get: async key => Object.prototype.hasOwnProperty.call(data.strings, key) ? data.strings[key] : null,
    set: async (key, value) => {
      data.strings[key] = String(value);
      await write();
    },
    hGetAll: async key => ({ ...(data.hashes[key] || {}) }),
    hSet: async (key, fieldOrValues, value) => {
      const values = typeof fieldOrValues === 'object'
        ? fieldOrValues
        : { [fieldOrValues]: value };
      const current = data.hashes[key] || {};
      Object.entries(values).forEach(([field, item]) => {
        current[field] = String(item);
      });
      data.hashes[key] = current;
      await write();
    },
    sAdd: async (key, ...values) => {
      const members = new Set(data.sets[key] || []);
      values.forEach(value => members.add(String(value)));
      data.sets[key] = [...members];
      await write();
    },
    sMembers: async key => [...(data.sets[key] || [])],
    sRem: async (key, ...values) => {
      const removals = new Set(values.map(value => String(value)));
      data.sets[key] = (data.sets[key] || []).filter(value => !removals.has(value));
      await write();
    },
    exists: async key => contains(key) ? 1 : 0,
    rename: async (source, destination) => {
      ['strings', 'hashes', 'sets'].forEach(bucket => {
        if (Object.prototype.hasOwnProperty.call(data[bucket], source)) {
          data[bucket][destination] = data[bucket][source];
          delete data[bucket][source];
        }
      });
      await write();
    },
    del: async (...keys) => {
      keys.forEach(key => {
        delete data.strings[key];
        delete data.hashes[key];
        delete data.sets[key];
      });
      await write();
    }
  };
};

const dataClient = PORTABLE_MODE ? createLocalDataClient(LOCAL_DATA_FILE) : createClient({ url: REDIS_URL });
dataClient.on('error', error => console.error('Storage connection error:', error.message));

const slugify = value => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const normalizeUsername = value => String(value || '').trim().toLowerCase();
const normalizeName = value => String(value || '').trim().toLowerCase();
const cleanText = (value, maxLength) => String(value || '').trim().slice(0, maxLength);
const validateUsername = value => {
  const normalized = normalizeUsername(value);
  if (!/^[a-z0-9_.-]{3,40}$/.test(normalized)) {
    throw new HttpError(400, 'Username must be 3-40 characters and use letters, numbers, dots, dashes, or underscores.');
  }
  return normalized;
};

const BASE_DEPARTMENTS = [
  {
    name: 'Civilian Department',
    subdivisions: [
      { name: '24/7 Supermarket', group: 'Businesses' },
      { name: 'Ammu-Nation', group: 'Businesses' },
      { name: "Casey's Highway Clearance", group: 'Businesses' },
      { name: 'Gruppe Sechs Security', id: 'civilian-department-grouppe-sechs-security', group: 'Businesses' },
      { name: 'Humane Labs & Research', group: 'Businesses' },
      { name: 'Jetsam Holdings', group: 'Businesses' },
      { name: "Roger's Salvage & Scrap", group: 'Businesses' },
      { name: 'Los Santos Transit', group: 'Businesses' },
      { name: 'Los Santos Department of Public Works', group: 'Businesses' },
      { name: 'McGill Olsen Construction', id: 'civilian-department-mcgill-olson-construction', group: 'Businesses' },
      { name: 'Merryweather Security', group: 'Businesses' },
      { name: 'Over The Tap Liquor', group: 'Businesses' },
      { name: 'Premium Deluxe Motorsports', group: 'Businesses' },
      { name: 'Ron Oil & Logistics', group: 'Businesses' },
      { name: 'San Andreas Medical Union', group: 'Businesses' },
      { name: 'The Union Depository', group: 'Businesses' },
      { name: 'San Andreas Foods', group: 'Businesses' },
      { name: 'Weazel News', group: 'Businesses' },
      { name: 'Ballas Street Gang', group: 'Gangs' },
      { name: 'Families Street Gang', group: 'Gangs' },
      { name: 'Vagos Street Gang', group: 'Gangs' },
      { name: 'Lost MC', group: 'Gangs' },
      { name: 'Reapers Poison MC', group: 'Gangs' },
      { name: 'The Dukes Family', group: 'Gangs' },
      { name: 'Zero Yōnin', group: 'Gangs' },
      { name: 'Velenza Syndicate', group: 'Gangs' }
    ]
  },
  {
    name: 'Los Santos Police Department',
    subdivisions: [
      { name: 'Port Authority' },
      { name: 'Special Intelligence Division' },
      { name: 'Traffic Enforcement Unit' }
    ]
  },
  {
    name: "Blaine County Sheriff's Office",
    subdivisions: [
      { name: 'WSU' },
      { name: 'WLR' },
      { name: 'CID' },
      { name: 'TED' },
      { name: 'Canine' }
    ]
  },
  {
    name: 'San Andreas Highway Patrol',
    subdivisions: [
      { name: 'BACO' },
      { name: 'Investigations' },
      { name: 'Canine' },
      { name: 'DUI' },
      { name: 'MBU' },
      { name: 'CVE' },
      { name: 'MRU' }
    ]
  },
  {
    name: 'Los Santos Fire Department',
    subdivisions: [
      { name: 'Division of Special Operations' },
      { name: 'Office of Fire Investigation' },
      { name: 'TSU' },
      { name: 'SanFire' }
    ]
  },
  {
    name: 'Communications Department',
    subdivisions: []
  }
];

const CATALOG_ADDITIONS = [
  {
    name: 'Civilian Department',
    subdivisions: BASE_DEPARTMENTS[0].subdivisions.filter(subdivision => subdivision.group === 'Gangs')
  },
  {
    name: 'Communications Department',
    subdivisions: []
  }
];
const FIRE_DEPARTMENT_ADDITION = BASE_DEPARTMENTS.find(department => department.name === 'Los Santos Fire Department');
const CATALOG_GROUP_UPDATES = [
  {
    name: 'Civilian Department',
    subdivisions: BASE_DEPARTMENTS[0].subdivisions
  }
];

const createDefaultDepartment = (department, teamId = DOJ_TEAM_ID, namespaceIds = false) => ({
  id: namespaceIds ? `${teamId}-${slugify(department.name)}` : slugify(department.name),
  teamId,
  name: department.name,
  enabled: true,
  color: '#4a5568',
  requiredHours: 0,
  subdivisions: department.subdivisions.map(subdivision => ({
    id: subdivision.id
      ? (namespaceIds ? `${teamId}-${subdivision.id}` : subdivision.id)
      : namespaceIds
        ? `${teamId}-${slugify(department.name)}-${slugify(subdivision.name)}`
        : `${slugify(department.name)}-${slugify(subdivision.name)}`,
    name: subdivision.name,
    ...(subdivision.group ? { group: subdivision.group } : {}),
    enabled: true,
    requiredHours: 0
  }))
});
const createDefaultDepartments = (teamId = DOJ_TEAM_ID, namespaceIds = false) =>
  BASE_DEPARTMENTS.map(department => createDefaultDepartment(department, teamId, namespaceIds));

const userKey = username => `tracky:user:${normalizeUsername(username)}`;
const departmentKey = username => `tracky:departments:${normalizeUsername(username)}`;
const entryKey = username => `tracky:entries:${normalizeUsername(username)}`;
const catalogVersionKey = username => `tracky:catalog-version:${normalizeUsername(username)}`;
const teamKey = teamId => `tracky:team:${String(teamId || '').trim()}`;
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hoursValue = value => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 744) {
    throw new HttpError(400, 'Monthly required hours must be between 0 and 744.');
  }
  return Math.round(parsed * 100) / 100;
};
const colorValue = value => {
  const color = String(value || '#4a5568').trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new HttpError(400, 'Department color must be a six-digit hex color.');
  }
  return color.toLowerCase();
};

const parseDate = (value, label) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date.`);
  return date.toISOString();
};

const loadJson = async (key, fallback) => {
  const value = await dataClient.get(key);
  return value ? JSON.parse(value) : fallback;
};
const saveJson = (key, value) => dataClient.set(key, JSON.stringify(value));
const getSettings = async () => {
  const settings = await loadJson(SETTINGS_KEY, {});
  return { allowRegistration: settings.allowRegistration === true };
};
const saveSettings = async updates => {
  const settings = { ...await getSettings(), ...updates };
  await saveJson(SETTINGS_KEY, settings);
  return settings;
};
const parseList = value => {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(item => String(item || '')).filter(Boolean) : [];
  } catch (error) {
    return [];
  }
};
const personalTeam = () => ({
  id: PERSONAL_TEAM_ID,
  name: PERSONAL_TEAM_NAME,
  personalized: true,
  lockDepartments: false,
  lockSubdivisions: false,
  personal: true
});
const createDojTeam = () => ({
  id: DOJ_TEAM_ID,
  name: 'Department of Justice RP',
  joinKey: 'DOJ',
  personalized: false,
  lockDepartments: true,
  lockSubdivisions: true,
  protected: true,
  departments: createDefaultDepartments()
});
const normalizeTeamOptions = input => {
  const personalized = input.personalized === true;
  const lockDepartments = personalized ? false : input.lockDepartments === true;
  const lockSubdivisions = personalized ? false : input.lockSubdivisions === true;
  return { personalized, lockDepartments, lockSubdivisions };
};
const getTeam = async teamId => {
  if (teamId === PERSONAL_TEAM_ID) return personalTeam();
  return loadJson(teamKey(teamId), null);
};
const saveTeam = async team => {
  await dataClient.sAdd(TEAMS_INDEX_KEY, team.id);
  await saveJson(teamKey(team.id), team);
  return team;
};
const listTeams = async () => {
  const teamIds = await dataClient.sMembers(TEAMS_INDEX_KEY);
  const teams = await Promise.all(teamIds.map(getTeam));
  return teams.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
};
const ensureSystemTeam = async () => {
  const existing = await getTeam(DOJ_TEAM_ID);
  if (!existing) {
    await saveTeam({ ...createDojTeam(), catalogVersion: DOJ_CATALOG_VERSION });
    return;
  }
  if (existing.catalogVersion !== DOJ_CATALOG_VERSION) {
    await saveTeam({
      ...existing,
      name: 'Department of Justice RP',
      joinKey: 'DOJ',
      personalized: false,
      lockDepartments: true,
      lockSubdivisions: true,
      protected: true,
      catalogVersion: DOJ_CATALOG_VERSION,
      departments: createDefaultDepartments()
    });
  }
};
const getUserTeamIds = user => {
  if (user && Object.prototype.hasOwnProperty.call(user, 'teamIds') && user.teamIds !== '') {
    return parseList(user.teamIds);
  }
  return [DOJ_TEAM_ID];
};
const getUserDisabledTeamIds = user => {
  const available = getUserTeamIds(user);
  return parseList(user?.disabledTeamIds).filter(teamId => available.includes(teamId));
};
const getDojProfile = user => {
  try {
    const profile = JSON.parse(user?.dojProfile || '{}');
    return {
      communityName: cleanText(profile.communityName, 80),
      email: cleanText(profile.email, 160),
      websiteId: cleanText(profile.websiteId, 80),
      idn: cleanText(profile.idn, 80),
      investigatorRank: cleanText(profile.investigatorRank, 80),
      bcsoRank: BCSO_RANKS.includes(profile.bcsoRank) ? profile.bcsoRank : '',
      callsigns: profile.callsigns && typeof profile.callsigns === 'object' ? profile.callsigns : {}
    };
  } catch (error) {
    return { communityName: '', email: '', websiteId: '', idn: '', investigatorRank: '', bcsoRank: '', callsigns: {} };
  }
};
const getUserTeamOrder = user => {
  const available = [...getUserTeamIds(user), PERSONAL_TEAM_ID];
  const stored = parseList(user?.teamOrder).filter(teamId => available.includes(teamId));
  return [...stored, ...available.filter(teamId => !stored.includes(teamId))];
};
const getOrderedUserTeams = async user => {
  const disabledTeamIds = new Set(getUserDisabledTeamIds(user));
  const byId = new Map((await Promise.all(getUserTeamIds(user).map(getTeam)))
    .filter(Boolean)
    .map(team => [team.id, { ...team, enabled: !disabledTeamIds.has(team.id) }]));
  byId.set(PERSONAL_TEAM_ID, { ...personalTeam(), enabled: true });
  return getUserTeamOrder(user).map(teamId => byId.get(teamId)).filter(Boolean);
};
const userHasTeam = (user, teamId) => teamId === PERSONAL_TEAM_ID || getUserTeamIds(user).includes(teamId);

const base64UrlEncode = value => Buffer.from(value).toString('base64url');
const signToken = payload => {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};
const verifyToken = token => {
  try {
    if (!token || !token.includes('.')) return null;
    const [encoded, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
    if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch (error) {
    return null;
  }
};
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex')
});
const passwordMatches = (password, user) => {
  if (!user.salt || !user.passwordHash) return false;
  const candidate = hashPassword(password, user.salt).hash;
  return candidate.length === user.passwordHash.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(user.passwordHash));
};

const getUser = async username => {
  const user = await dataClient.hGetAll(userKey(username));
  return user && user.username ? user : null;
};
const publicUser = user => ({
  username: user.username,
  role: user.role === 'admin' ? 'admin' : 'user',
  createdAt: user.createdAt || '',
  teamIds: getUserTeamIds(user),
  teamOrder: getUserTeamOrder(user),
  disabledTeamIds: getUserDisabledTeamIds(user)
});
const mergeCatalogAdditions = departments => {
  let changed = false;
  CATALOG_ADDITIONS.map(createDefaultDepartment).forEach(defaultDepartment => {
    const existing = departments.find(department => normalizeName(department.name) === normalizeName(defaultDepartment.name));
    if (!existing) {
      departments.push(defaultDepartment);
      changed = true;
      return;
    }
    defaultDepartment.subdivisions.forEach(subdivision => {
      const existingSubdivision = (existing.subdivisions || []).find(item =>
        normalizeName(item.name) === normalizeName(subdivision.name)
      );
      if (!existingSubdivision) {
        if (!existing.subdivisions) existing.subdivisions = [];
        existing.subdivisions.push(subdivision);
        changed = true;
      } else if (subdivision.group && existingSubdivision.group !== subdivision.group) {
        existingSubdivision.group = subdivision.group;
        changed = true;
      }
    });
  });
  return changed;
};
const mergeCatalogGroups = departments => {
  let changed = false;
  CATALOG_GROUP_UPDATES.forEach(defaultDepartment => {
    const existing = departments.find(department => normalizeName(department.name) === normalizeName(defaultDepartment.name));
    if (!existing) return;
    defaultDepartment.subdivisions.forEach(defaultSubdivision => {
      const subdivision = (existing.subdivisions || []).find(item =>
        normalizeName(item.name) === normalizeName(defaultSubdivision.name)
      );
      if (subdivision && defaultSubdivision.group && subdivision.group !== defaultSubdivision.group) {
        subdivision.group = defaultSubdivision.group;
        changed = true;
      }
    });
  });
  return changed;
};
const addDefaultDepartmentIfMissing = (departments, defaultDepartment) => {
  if (departments.some(department => normalizeName(department.name) === normalizeName(defaultDepartment.name))) {
    return false;
  }
  const communicationsIndex = departments.findIndex(department =>
    normalizeName(department.name) === normalizeName('Communications Department')
  );
  departments.splice(communicationsIndex < 0 ? departments.length : communicationsIndex, 0, createDefaultDepartment(defaultDepartment));
  return true;
};
const structuralDepartmentIds = new Set(createDefaultDepartments().map(department => department.id));
const withTeamId = (department, teamId) => ({
  ...department,
  teamId,
  subdivisions: (department.subdivisions || []).map(subdivision => ({ ...subdivision }))
});
const mergeDepartmentPreferences = (template, stored) => ({
  ...template,
  enabled: stored?.enabled !== false,
  color: stored?.color || template.color || '#4a5568',
  requiredHours: Number(stored?.requiredHours || 0),
  subdivisions: (template.subdivisions || []).map(subdivision => {
    const saved = stored?.subdivisions?.find(item => item.id === subdivision.id ||
      normalizeName(item.name) === normalizeName(subdivision.name));
    return {
      ...subdivision,
      enabled: saved?.enabled !== false,
      requiredHours: Number(saved?.requiredHours || 0)
    };
  })
});
const sortBySavedOrder = (departments, savedDepartments) => {
  const indices = new Map(savedDepartments.map((department, index) => [department.id, index]));
  return [...departments].sort((left, right) => {
    const leftIndex = indices.has(left.id) ? indices.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightIndex = indices.has(right.id) ? indices.get(right.id) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
};
const syncUserDepartments = async (username, options = {}) => {
  const user = await getUser(username);
  if (!user) return [];
  const stored = await loadJson(departmentKey(username), []);
  const teams = await getOrderedUserTeams(user);
  const personal = stored.filter(department => (department.teamId || PERSONAL_TEAM_ID) === PERSONAL_TEAM_ID);
  const next = [];
  teams.forEach(team => {
    if (team.id === PERSONAL_TEAM_ID) {
      next.push(...personal.map(department => withTeamId(department, PERSONAL_TEAM_ID)));
      return;
    }
    const prior = stored.filter(department => department.teamId === team.id ||
      (team.id === DOJ_TEAM_ID && !department.teamId && structuralDepartmentIds.has(department.id)));
    if (team.personalized) {
      if (prior.length) {
        const userDepartments = prior.map(department => withTeamId(department, team.id));
        if (options.restorePersonalized) {
          (team.departments || []).forEach(defaultDepartment => {
            const existing = userDepartments.find(department => department.id === defaultDepartment.id);
            if (!existing) {
              userDepartments.push(withTeamId(defaultDepartment, team.id));
              return;
            }
            (defaultDepartment.subdivisions || []).forEach(defaultSubdivision => {
              if (!existing.subdivisions.some(subdivision => subdivision.id === defaultSubdivision.id)) {
                existing.subdivisions.push({ ...defaultSubdivision });
              }
            });
          });
        }
        next.push(...userDepartments);
      } else if (options.restorePersonalized || options.newMembership) {
        next.push(...(team.departments || []).map(department => withTeamId(department, team.id)));
      }
      return;
    }
    const synchronized = (team.departments || []).map(template =>
      mergeDepartmentPreferences(withTeamId(template, team.id), prior.find(department => department.id === template.id))
    );
    next.push(...sortBySavedOrder(synchronized, prior));
  });
  await saveJson(departmentKey(username), next);
  return next;
};
const syncTeamMembers = async teamId => {
  const users = await listUsers();
  await Promise.all(users.filter(user => userHasTeam(user, teamId)).map(user => syncUserDepartments(user.username)));
};
const initializeWorkspace = async username => {
  await ensureSystemTeam();
  const user = await getUser(username);
  if (!user) return;
  const previousCatalogVersion = await dataClient.get(catalogVersionKey(username));
  if (previousCatalogVersion !== CURRENT_CATALOG_VERSION) {
    const existing = await loadJson(departmentKey(username), []);
    const migrated = existing.map(department => withTeamId(
      department,
      structuralDepartmentIds.has(department.id) ? DOJ_TEAM_ID : PERSONAL_TEAM_ID
    ));
    await saveJson(departmentKey(username), migrated);
    await dataClient.hSet(userKey(username), {
      teamIds: JSON.stringify(getUserTeamIds(user)),
      teamOrder: JSON.stringify(getUserTeamOrder(user)),
      disabledTeamIds: JSON.stringify(getUserDisabledTeamIds(user))
    });
    await dataClient.set(catalogVersionKey(username), CURRENT_CATALOG_VERSION);
  }
  await syncUserDepartments(username, { newMembership: true });
  if (!await dataClient.exists(entryKey(username))) {
    await saveJson(entryKey(username), []);
  }
};
const createUser = async ({ username, password, role = 'user', teamIds = [DOJ_TEAM_ID] }) => {
  const normalized = validateUsername(username);
  if (String(password || '').length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters.');
  }
  if (await getUser(normalized)) throw new HttpError(409, 'Username is already in use.');
  const credential = hashPassword(password);
  await dataClient.hSet(userKey(normalized), {
    username: normalized,
    role: role === 'admin' ? 'admin' : 'user',
    salt: credential.salt,
    passwordHash: credential.hash,
    createdAt: new Date().toISOString(),
    teamIds: JSON.stringify(teamIds.filter(teamId => teamId !== PERSONAL_TEAM_ID)),
    teamOrder: JSON.stringify([...teamIds.filter(teamId => teamId !== PERSONAL_TEAM_ID), PERSONAL_TEAM_ID]),
    disabledTeamIds: JSON.stringify([]),
    dojProfile: JSON.stringify({ communityName: '', email: '', websiteId: '', idn: '', investigatorRank: '', bcsoRank: '', callsigns: {} })
  });
  await dataClient.sAdd(USERS_INDEX_KEY, normalized);
  await initializeWorkspace(normalized);
  return getUser(normalized);
};
const renameUser = async (currentUsername, requestedUsername) => {
  const previous = normalizeUsername(currentUsername);
  const next = validateUsername(requestedUsername);
  if (previous === next) return getUser(previous);
  if (await getUser(next) ||
    await dataClient.exists(departmentKey(next)) ||
    await dataClient.exists(entryKey(next)) ||
    await dataClient.exists(catalogVersionKey(next))) {
    throw new HttpError(409, 'Username is already in use.');
  }
  const user = await getUser(previous);
  if (!user) throw new HttpError(404, 'User not found.');
  await dataClient.hSet(userKey(next), { ...user, username: next });
  for (const keyFactory of [departmentKey, entryKey, catalogVersionKey]) {
    if (await dataClient.exists(keyFactory(previous))) {
      await dataClient.rename(keyFactory(previous), keyFactory(next));
    }
  }
  await dataClient.sRem(USERS_INDEX_KEY, previous);
  await dataClient.sAdd(USERS_INDEX_KEY, next);
  await dataClient.del(userKey(previous));
  return getUser(next);
};
const listUsers = async () => {
  const usernames = await dataClient.sMembers(USERS_INDEX_KEY);
  const users = await Promise.all(usernames.map(getUser));
  return users.filter(Boolean).sort((left, right) => left.username.localeCompare(right.username));
};
const ensureAdmin = async () => {
  if (!await getUser(DEFAULT_ADMIN_USERNAME)) {
    await createUser({
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      role: 'admin'
    });
  }
};

const requireAuth = asyncRoute(async (req, res, next) => {
  const header = String(req.headers.authorization || '');
  const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!payload?.username) throw new HttpError(401, 'Authentication required.');
  const user = await getUser(payload.username);
  if (!user) throw new HttpError(401, 'Authentication required.');
  req.user = publicUser(user);
  next();
});
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return next(new HttpError(403, 'Administrator access required.'));
  next();
};

const getDepartments = async username => {
  await initializeWorkspace(username);
  const user = await getUser(username);
  const teams = new Map((await getOrderedUserTeams(user)).map(team => [team.id, team]));
  const departments = await loadJson(departmentKey(username), []);
  return departments.map(department => ({
    ...department,
    teamId: department.teamId || PERSONAL_TEAM_ID,
    teamName: teams.get(department.teamId || PERSONAL_TEAM_ID)?.name || PERSONAL_TEAM_NAME,
    teamEnabled: teams.get(department.teamId || PERSONAL_TEAM_ID)?.enabled !== false,
    canEditDepartments: user.role === 'admin' ||
      teams.get(department.teamId || PERSONAL_TEAM_ID)?.personalized === true ||
      teams.get(department.teamId || PERSONAL_TEAM_ID)?.lockDepartments !== true,
    canEditSubdivisions: user.role === 'admin' ||
      teams.get(department.teamId || PERSONAL_TEAM_ID)?.personalized === true ||
      teams.get(department.teamId || PERSONAL_TEAM_ID)?.lockSubdivisions !== true,
    enabled: department.enabled !== false,
    subdivisions: (department.subdivisions || []).map(subdivision => ({
      ...subdivision,
      enabled: subdivision.enabled !== false
    }))
  }));
};
const saveDepartments = (username, departments) => saveJson(departmentKey(username), departments);
const requireDepartmentPermission = async (user, department, type) => {
  const team = await getTeam(department.teamId || PERSONAL_TEAM_ID);
  if (user.role === 'admin' || team?.personalized ||
    (type === 'department' ? team?.lockDepartments !== true : team?.lockSubdivisions !== true)) {
    return team || personalTeam();
  }
  throw new HttpError(403, `${type === 'department' ? 'Department' : 'Subdivision'} editing is locked to administrators for this team.`);
};
const updateSharedTeamTemplate = async (team, departments) => {
  if (!team || team.id === PERSONAL_TEAM_ID || team.personalized) return;
  team.departments = departments
    .filter(department => department.teamId === team.id)
    .map(department => ({
      ...department,
      enabled: true,
      requiredHours: 0,
      subdivisions: department.subdivisions.map(subdivision => ({
        ...subdivision,
        enabled: true,
        requiredHours: 0
      }))
    }));
  await saveTeam(team);
  await syncTeamMembers(team.id);
};
const entrySegments = entry => Array.isArray(entry.segments) && entry.segments.length
  ? entry.segments
  : [{
      id: `${entry.id}-segment-1`,
      subdivisionId: entry.subdivisionId || '',
      subdivisionName: entry.subdivisionName || '',
      startAt: entry.startAt,
      endAt: entry.endAt
    }];
const normalizeEntry = entry => ({
  ...entry,
  segments: entrySegments(entry)
});
const getEntries = async username => {
  await initializeWorkspace(username);
  return (await loadJson(entryKey(username), [])).map(normalizeEntry);
};
const saveEntries = (username, entries) => saveJson(entryKey(username), entries);
const findDepartment = (departments, departmentId) => departments.find(department => department.id === departmentId);
const findSubdivision = (department, subdivisionId) =>
  department?.subdivisions.find(subdivision => subdivision.id === subdivisionId);
const setFormValue = (params, key, value) => params.set(key, String(value ?? ''));
const setOptionalFormValue = (params, key, value) => {
  const text = String(value ?? '').trim();
  if (text) params.set(key, text);
};
const setUtcDateFields = (params, prefix, value) => {
  const date = new Date(value);
  setFormValue(params, `${prefix}_hour`, String(date.getUTCHours()).padStart(2, '0'));
  setFormValue(params, `${prefix}_minute`, String(date.getUTCMinutes()).padStart(2, '0'));
  setFormValue(params, `${prefix}_year`, date.getUTCFullYear());
  setFormValue(params, `${prefix}_month`, date.getUTCMonth() + 1);
  setFormValue(params, `${prefix}_day`, date.getUTCDate());
};
const durationParts = milliseconds => {
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  return {
    hours: String(Math.floor(minutes / 60)).padStart(2, '0'),
    minutes: String(minutes % 60).padStart(2, '0')
  };
};
const setDurationFields = (params, prefix, milliseconds) => {
  const duration = durationParts(milliseconds);
  setFormValue(params, `${prefix}_hour`, duration.hours);
  setFormValue(params, `${prefix}_minute`, duration.minutes);
  setFormValue(params, `${prefix}_second`, '00');
};
const groupedSubdivisionDurations = entry => {
  const groups = [];
  const byId = new Map();
  entrySegments(entry).filter(segment => segment.subdivisionId).forEach(segment => {
    const current = byId.get(segment.subdivisionId) || {
      subdivisionId: segment.subdivisionId,
      subdivisionName: segment.subdivisionName,
      milliseconds: 0
    };
    current.milliseconds += Math.max(0, new Date(segment.endAt || entry.endAt).getTime() - new Date(segment.startAt).getTime());
    if (!byId.has(segment.subdivisionId)) groups.push(current);
    byId.set(segment.subdivisionId, current);
  });
  return groups;
};
const formIdentity = (profile, department) =>
  [profile.communityName, profile.callsigns[department.id]].filter(Boolean).join(' ');
const civilianFormName = name => {
  const formNames = {
    '24/7 supermarket': '24/7 Convenience Stores',
    'ammu-nation': 'Ammu-Nation Weapon Store',
    "casey's highway clearance": "Casey's Highway Clearance & Auto Repairs",
    'grouppe sechs security': 'Gruppe Sechs Security',
    'gruppe sechs security': 'Gruppe Sechs Security',
    'humane labs & research': 'Humane Labs & Research',
    'jetsam holdings': 'Jetsam Holdings',
    "roger's salvage & scrap": 'Rogers Salvage & Scrap',
    'los santos transit': 'Los Santos Transit',
    'los santos department of public works': 'Los Santos Department of Public Works',
    'mcgill olsen construction': 'McGill-Olsen Construction',
    'mcgill-olson construction': 'McGill-Olsen Construction',
    'merryweather security': 'Merryweather Security',
    'over the tap liquor': 'Over The Tap Liquor',
    'premium deluxe motorsports': 'Premium Deluxe Motorsports',
    'ron oil & logistics': 'Ron Oil & Logistics',
    'san andreas medical union': 'San Andreas Medical Union',
    'the union depository': 'The Union Depository',
    'san andreas foods': 'San Andreas Foods',
    'weazel news': 'Weazel News',
    'ballas street gang': 'Ballas Street Gang',
    'families street gang': 'Families Street Gang',
    'vagos street gang': 'Vagos Street Gang',
    'lost mc': 'Lost MC',
    'reapers poison mc': 'Reapers Poison MC',
    'the dukes family': 'The Dukes Family',
    'velenza syndicate': 'Valenza Syndicate'
  };
  if (String(name || '').toLowerCase().startsWith('zero ')) return 'Zero Yonin';
  return formNames[normalizeName(name)] || name;
};
const buildDojFormUrl = (entry, department, profile) => {
  const config = DOJ_FORM_CONFIGS[department.id];
  if (!config) throw new HttpError(400, 'No Google Form is configured for that DOJ department.');
  const params = new URLSearchParams({ usp: 'pp_url' });
  const subdivisions = groupedSubdivisionDurations(entry);
  const subdivisionDurations = new Map(subdivisions.map(subdivision => [normalizeName(subdivision.subdivisionName), subdivision.milliseconds]));
  const totalMilliseconds = Math.max(0, new Date(entry.endAt).getTime() - new Date(entry.startAt).getTime());
  setOptionalFormValue(params, 'emailAddress', profile.email);
  if (config.type === 'civilian') {
    setFormValue(params, 'entry.1076518144', 'UTC -0 (GMT)');
    setOptionalFormValue(params, 'entry.1281296250', formIdentity(profile, department));
    setOptionalFormValue(params, 'entry.441531994', profile.websiteId);
    setUtcDateFields(params, 'entry.1173078942', entry.startAt);
    setDurationFields(params, 'entry.1727523701', totalMilliseconds);
    setFormValue(params, 'entry.345451391', subdivisions.length ? 'Yes' : 'No');
    const fields = [
      ['entry.91681594', 'entry.1410414271'],
      ['entry.810117208', 'entry.275813669'],
      ['entry.1005807483', 'entry.884574783']
    ];
    setFormValue(params, 'entry.210147639', subdivisions.length > 1 ? 'Yes' : 'No');
    setFormValue(params, 'entry.70281007', subdivisions.length > 2 ? 'Yes' : 'No');
    subdivisions.slice(0, 3).forEach((subdivision, index) => {
      setFormValue(params, fields[index][0], civilianFormName(subdivision.subdivisionName));
      setDurationFields(params, fields[index][1], subdivision.milliseconds);
    });
  }
  if (config.type === 'lspd') {
    setOptionalFormValue(params, 'entry.998812919', formIdentity(profile, department));
    setOptionalFormValue(params, 'entry.699618360', profile.websiteId);
    setFormValue(params, 'entry.952718778', 'UTC (GMT)');
    setFormValue(params, 'entry.1132611911', 'Patrol Log');
    setUtcDateFields(params, 'entry.1056448932', entry.startAt);
    setUtcDateFields(params, 'entry.483572440', entry.endAt);
    const lspdNames = {
      'port authority': 'Port Authority',
      'special intelligence division': 'Special Intelligence Division',
      'traffic enforcement unit': 'Traffic Enforcement'
    };
    setFormValue(params, 'entry.1338139738', subdivisions.length
      ? (lspdNames[normalizeName(subdivisions[0].subdivisionName)] || subdivisions[0].subdivisionName)
      : 'N/A');
    const sidDuration = subdivisionDurations.get('special intelligence division');
    if (sidDuration !== undefined) {
      setOptionalFormValue(params, 'entry.180325416', profile.idn);
      setOptionalFormValue(params, 'entry.1239803050', profile.investigatorRank);
      setDurationFields(params, 'entry.998704443', sidDuration);
    }
    if (subdivisionDurations.has('port authority')) setDurationFields(params, 'entry.1462695973', subdivisionDurations.get('port authority'));
    if (subdivisionDurations.has('traffic enforcement unit')) setDurationFields(params, 'entry.219664856', subdivisionDurations.get('traffic enforcement unit'));
  }
  if (config.type === 'sahp') {
    setOptionalFormValue(params, 'entry.44090836', formIdentity(profile, department));
    setOptionalFormValue(params, 'entry.1185242731', profile.websiteId);
    setFormValue(params, 'entry.926732721', 'GMT');
    setUtcDateFields(params, 'entry.874254809', entry.startAt);
    setUtcDateFields(params, 'entry.471559059', entry.endAt);
    setFormValue(params, 'entry.2019176256', subdivisions.length ? 'Yes' : 'No');
    setFormValue(params, 'entry.539881772', 'Standard Patrol');
    const sahpFields = {
      baco: 'entry.754081532',
      investigations: 'entry.1482741082',
      canine: 'entry.1099238848',
      dui: 'entry.1352450409',
      mbu: 'entry.1263679487',
      cve: 'entry.1919106217',
      mru: 'entry.579749179'
    };
    Object.entries(sahpFields).forEach(([name, prefix]) => {
      if (subdivisionDurations.has(name)) setDurationFields(params, prefix, subdivisionDurations.get(name));
    });
  }
  if (config.type === 'bcso') {
    setOptionalFormValue(params, 'entry.1019179407', profile.websiteId);
    setOptionalFormValue(params, 'entry.214679648', profile.bcsoRank);
    setOptionalFormValue(params, 'entry.805651499', formIdentity(profile, department));
    setFormValue(params, 'entry.324817261', 'GMT');
    setUtcDateFields(params, 'entry.243689543', entry.startAt);
    setUtcDateFields(params, 'entry.1076382024', entry.endAt);
    setDurationFields(params, 'entry.980582373', totalMilliseconds);
    setFormValue(params, 'entry.1610264503', subdivisions.length ? 'Yes' : 'No');
    const bcsoFields = {
      wsu: 'entry.1284273733',
      wlr: 'entry.1548375218',
      cid: 'entry.313224238',
      ted: 'entry.1471195366',
      canine: 'entry.1881504976'
    };
    Object.entries(bcsoFields).forEach(([name, prefix]) => {
      if (subdivisionDurations.has(name)) setDurationFields(params, prefix, subdivisionDurations.get(name));
    });
  }
  if (config.type === 'communications') {
    setOptionalFormValue(params, 'entry.1504138626', formIdentity(profile, department));
    setOptionalFormValue(params, 'entry.381718269', profile.websiteId);
    setFormValue(params, 'entry.725494750', 'UTC');
    setUtcDateFields(params, 'entry.1201164071', entry.startAt);
    setUtcDateFields(params, 'entry.1618657701', entry.endAt);
    setFormValue(params, 'entry.1284541558', 'Patrol Activity');
  }
  if (config.type === 'fire') {
    setOptionalFormValue(params, 'entry.209084214', profile.websiteId);
    setOptionalFormValue(params, 'entry.1827709301', formIdentity(profile, department));
    setFormValue(params, 'entry.877197655', 'UTC');
    setUtcDateFields(params, 'entry.292361965', entry.startAt);
    setUtcDateFields(params, 'entry.1465251400', entry.endAt);
    setFormValue(params, 'entry.947689798', 'Patrol Log [Patrols, Activations, Ridealongs]');
    setFormValue(params, 'entry.1391636004', subdivisions.length ? 'Yes' : 'No');
    const fireFields = {
      'division of special operations': 'entry.1033506814',
      'office of fire investigation': 'entry.177072469',
      'office of fire investigations': 'entry.177072469',
      tsu: 'entry.1772682038',
      'tactical support unit': 'entry.1772682038',
      sanfire: 'entry.789182892'
    };
    Object.entries(fireFields).forEach(([name, prefix]) => {
      if (subdivisionDurations.has(name)) setDurationFields(params, prefix, subdivisionDurations.get(name));
    });
  }
  const query = params.toString()
    .replace(/\+/g, '%20')
    .replace(/%28/gi, '(')
    .replace(/%29/gi, ')')
    .replace(/%40/gi, '@');
  return `${config.url}?${query}`;
};
const resolveAssignment = async (username, departmentId, subdivisionId, options = {}) => {
  const departments = await getDepartments(username);
  const department = findDepartment(departments, departmentId);
  if (!department) {
    throw new HttpError(400, 'Choose a valid department.');
  }
  if (department.teamEnabled === false && !options.allowDisabled) throw new HttpError(400, 'That team is disabled.');
  if (department.enabled === false && !options.allowDisabled) throw new HttpError(400, 'That department is disabled.');
  const subdivision = subdivisionId ? findSubdivision(department, subdivisionId) : null;
  if (subdivisionId && !subdivision) throw new HttpError(400, 'Choose a valid subdivision.');
  if (subdivision?.enabled === false && !options.allowDisabled) throw new HttpError(400, 'That subdivision is disabled.');
  return { department, subdivision };
};

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'Tracky' }));

app.get('/api/auth/registration', asyncRoute(async (req, res) => {
  const settings = await getSettings();
  res.json({ enabled: settings.allowRegistration });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const attemptKey = `${req.ip}:${username}`;
  const attempt = loginAttempts.get(attemptKey);
  if (attempt && attempt.count >= LOGIN_MAX_ATTEMPTS && attempt.resetAt > Date.now()) {
    res.set('Retry-After', String(Math.ceil((attempt.resetAt - Date.now()) / 1000)));
    throw new HttpError(429, 'Too many login attempts. Try again later.');
  }
  const user = await getUser(username);
  if (!user || !passwordMatches(String(req.body.password || ''), user)) {
    const next = attempt && attempt.resetAt > Date.now()
      ? { ...attempt, count: attempt.count + 1 }
      : { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS };
    loginAttempts.set(attemptKey, next);
    throw new HttpError(401, 'Invalid username or password.');
  }
  loginAttempts.delete(attemptKey);
  await initializeWorkspace(user.username);
  const safeUser = publicUser(user);
  res.json({
    token: signToken({ username: user.username, exp: Date.now() + TOKEN_LIFETIME_MS }),
    user: safeUser
  });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const settings = await getSettings();
  if (!settings.allowRegistration) {
    throw new HttpError(403, 'Account registration is not currently available.');
  }
  const requestedKey = cleanText(req.body.teamKey, 100).toLowerCase();
  let teamIds = [];
  if (requestedKey) {
    const team = (await listTeams()).find(candidate =>
      String(candidate.joinKey || '').trim().toLowerCase() === requestedKey
    );
    if (!team) throw new HttpError(404, 'No team matches that key.');
    teamIds = [team.id];
  }
  const user = await createUser({
    username: req.body.username,
    password: req.body.password,
    role: 'user',
    teamIds
  });
  const safeUser = publicUser(user);
  res.status(201).json({
    token: signToken({ username: user.username, exp: Date.now() + TOKEN_LIFETIME_MS }),
    user: safeUser
  });
}));

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

app.patch('/api/auth/password', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  if (!passwordMatches(String(req.body.currentPassword || ''), user)) {
    throw new HttpError(400, 'Current password is incorrect.');
  }
  if (String(req.body.newPassword || '').length < 6) {
    throw new HttpError(400, 'New password must be at least 6 characters.');
  }
  const credential = hashPassword(String(req.body.newPassword));
  await dataClient.hSet(userKey(user.username), {
    salt: credential.salt,
    passwordHash: credential.hash
  });
  res.json({ success: true });
}));

app.patch('/api/auth/username', requireAuth, asyncRoute(async (req, res) => {
  const user = await renameUser(req.user.username, req.body.username);
  const safeUser = publicUser(user);
  res.json({
    token: signToken({ username: user.username, exp: Date.now() + TOKEN_LIFETIME_MS }),
    user: safeUser
  });
}));

app.patch('/api/auth/doj-profile', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  if (!userHasTeam(user, DOJ_TEAM_ID)) {
    throw new HttpError(403, 'Join Department of Justice RP to manage DOJ account options.');
  }
  const communityName = cleanText(req.body.communityName, 80);
  if (communityName && !/^[A-Za-z][A-Za-z'-]* [A-Za-z]\.$/.test(communityName)) {
    throw new HttpError(400, 'Community name must be formatted like Cleo M.');
  }
  const email = cleanText(req.body.email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  const websiteId = cleanText(req.body.websiteId, 80);
  const idn = cleanText(req.body.idn, 80);
  const investigatorRank = cleanText(req.body.investigatorRank, 80);
  const bcsoRank = cleanText(req.body.bcsoRank, 80);
  if (bcsoRank && !BCSO_RANKS.includes(bcsoRank)) {
    throw new HttpError(400, 'Choose a valid BCSO rank.');
  }
  const dojTeam = await getTeam(DOJ_TEAM_ID);
  const allowedCallsignIds = new Set();
  (dojTeam?.departments || []).forEach(department => {
    allowedCallsignIds.add(department.id);
    (department.subdivisions || []).forEach(subdivision => allowedCallsignIds.add(subdivision.id));
  });
  const callsigns = {};
  Object.entries(req.body.callsigns && typeof req.body.callsigns === 'object' ? req.body.callsigns : {}).forEach(([id, value]) => {
    if (allowedCallsignIds.has(id)) {
      const callsign = cleanText(value, 40);
      if (callsign) callsigns[id] = callsign;
    }
  });
  const profile = { communityName, email, websiteId, idn, investigatorRank, bcsoRank, callsigns };
  await dataClient.hSet(userKey(user.username), 'dojProfile', JSON.stringify(profile));
  res.json(profile);
}));

app.post('/api/teams/join', requireAuth, asyncRoute(async (req, res) => {
  const joinKey = String(req.body.key || '').trim().toLowerCase();
  if (!joinKey) throw new HttpError(400, 'Enter a team key.');
  const team = (await listTeams()).find(candidate => String(candidate.joinKey || '').trim().toLowerCase() === joinKey);
  if (!team) throw new HttpError(404, 'No team matches that key.');
  const user = await getUser(req.user.username);
  const teamIds = getUserTeamIds(user);
  if (!teamIds.includes(team.id)) teamIds.push(team.id);
  const teamOrder = [...getUserTeamOrder(user).filter(teamId => teamId !== PERSONAL_TEAM_ID), team.id, PERSONAL_TEAM_ID]
    .filter((teamId, index, values) => values.indexOf(teamId) === index);
  await dataClient.hSet(userKey(user.username), {
    teamIds: JSON.stringify(teamIds),
    teamOrder: JSON.stringify(teamOrder),
    disabledTeamIds: JSON.stringify(getUserDisabledTeamIds(user).filter(teamId => teamId !== team.id))
  });
  await syncUserDepartments(user.username, { newMembership: true });
  res.json({ success: true, team: { id: team.id, name: team.name } });
}));

app.patch('/api/teams/:teamId/visibility', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  const teamId = String(req.params.teamId || '');
  if (teamId === PERSONAL_TEAM_ID) throw new HttpError(400, 'Personal Departments cannot be disabled.');
  if (!userHasTeam(user, teamId)) throw new HttpError(404, 'Team membership not found.');
  const disabledTeamIds = new Set(getUserDisabledTeamIds(user));
  if (req.body.enabled === false) disabledTeamIds.add(teamId);
  else disabledTeamIds.delete(teamId);
  await dataClient.hSet(userKey(user.username), 'disabledTeamIds', JSON.stringify([...disabledTeamIds]));
  res.json(await getOrderedUserTeams(await getUser(user.username)));
}));

app.delete('/api/teams/:teamId/membership', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  const teamId = String(req.params.teamId || '');
  if (teamId === PERSONAL_TEAM_ID) throw new HttpError(400, 'Personal Departments is always available.');
  if (!userHasTeam(user, teamId)) throw new HttpError(404, 'Team membership not found.');
  const teamIds = getUserTeamIds(user).filter(item => item !== teamId);
  const teamOrder = getUserTeamOrder(user).filter(item => item !== teamId);
  await dataClient.hSet(userKey(user.username), {
    teamIds: JSON.stringify(teamIds),
    teamOrder: JSON.stringify(teamOrder.includes(PERSONAL_TEAM_ID) ? teamOrder : [...teamOrder, PERSONAL_TEAM_ID]),
    disabledTeamIds: JSON.stringify(getUserDisabledTeamIds(user).filter(item => item !== teamId))
  });
  await syncUserDepartments(user.username);
  res.json({ success: true });
}));

app.patch('/api/teams/order', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  const available = [...getUserTeamIds(user), PERSONAL_TEAM_ID];
  const teamIds = Array.isArray(req.body.teamIds) ? req.body.teamIds : [];
  if (teamIds.length !== available.length ||
    new Set(teamIds).size !== available.length ||
    teamIds.some(teamId => !available.includes(teamId))) {
    throw new HttpError(400, 'teamIds must include every available team exactly once.');
  }
  await dataClient.hSet(userKey(user.username), 'teamOrder', JSON.stringify(teamIds));
  await syncUserDepartments(user.username);
  res.json(await getOrderedUserTeams(await getUser(user.username)));
}));

app.get('/api/admin/teams', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json(await listTeams());
}));

app.get('/api/admin/settings', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json(await getSettings());
}));

app.patch('/api/admin/settings', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json(await saveSettings({ allowRegistration: req.body.allowRegistration === true }));
}));

app.post('/api/admin/teams', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 100);
  const joinKey = cleanText(req.body.joinKey, 100);
  if (!name || !joinKey) throw new HttpError(400, 'Team name and key are required.');
  const teams = await listTeams();
  if (teams.some(team => normalizeName(team.name) === normalizeName(name))) {
    throw new HttpError(409, 'A team with that name already exists.');
  }
  if (teams.some(team => normalizeName(team.joinKey) === normalizeName(joinKey))) {
    throw new HttpError(409, 'A team with that key already exists.');
  }
  const options = normalizeTeamOptions(req.body);
  const id = `${slugify(name) || 'team'}-${crypto.randomUUID().slice(0, 8)}`;
  const team = {
    id,
    name,
    joinKey,
    ...options,
    departments: options.personalized ? createDefaultDepartments(id, true) : []
  };
  await saveTeam(team);
  const admin = await getUser(req.user.username);
  const teamIds = [...getUserTeamIds(admin), id];
  await dataClient.hSet(userKey(admin.username), {
    teamIds: JSON.stringify(teamIds),
    teamOrder: JSON.stringify([...getUserTeamOrder(admin).filter(teamId => teamId !== PERSONAL_TEAM_ID), id, PERSONAL_TEAM_ID]),
    disabledTeamIds: JSON.stringify(getUserDisabledTeamIds(admin).filter(teamId => teamId !== id))
  });
  await syncUserDepartments(admin.username, { newMembership: true });
  res.status(201).json(team);
}));

app.patch('/api/admin/teams/:teamId', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const team = await getTeam(req.params.teamId);
  if (!team || team.id === PERSONAL_TEAM_ID) throw new HttpError(404, 'Team not found.');
  const name = cleanText(req.body.name, 100);
  const joinKey = cleanText(req.body.joinKey, 100);
  if (!name || !joinKey) throw new HttpError(400, 'Team name and key are required.');
  const teams = await listTeams();
  if (teams.some(item => item.id !== team.id && normalizeName(item.name) === normalizeName(name))) {
    throw new HttpError(409, 'A team with that name already exists.');
  }
  if (teams.some(item => item.id !== team.id && normalizeName(item.joinKey) === normalizeName(joinKey))) {
    throw new HttpError(409, 'A team with that key already exists.');
  }
  const options = team.protected
    ? { personalized: false, lockDepartments: true, lockSubdivisions: true }
    : normalizeTeamOptions(req.body);
  Object.assign(team, { name, joinKey, ...options });
  if (options.personalized && !team.departments.length) team.departments = createDefaultDepartments(team.id, true);
  await saveTeam(team);
  await syncTeamMembers(team.id);
  res.json(team);
}));

app.delete('/api/admin/teams/:teamId', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const team = await getTeam(req.params.teamId);
  if (!team) throw new HttpError(404, 'Team not found.');
  if (team.protected || team.id === DOJ_TEAM_ID) throw new HttpError(400, 'The Department of Justice RP team cannot be deleted.');
  const users = await listUsers();
  await Promise.all(users.filter(user => userHasTeam(user, team.id)).map(async user => {
    const nextTeamIds = getUserTeamIds(user).filter(teamId => teamId !== team.id);
    const nextOrder = getUserTeamOrder(user).filter(teamId => teamId !== team.id);
    await dataClient.hSet(userKey(user.username), {
      teamIds: JSON.stringify(nextTeamIds),
      teamOrder: JSON.stringify(nextOrder.includes(PERSONAL_TEAM_ID) ? nextOrder : [...nextOrder, PERSONAL_TEAM_ID]),
      disabledTeamIds: JSON.stringify(getUserDisabledTeamIds(user).filter(teamId => teamId !== team.id))
    });
    await syncUserDepartments(user.username);
  }));
  await dataClient.del(teamKey(team.id));
  await dataClient.sRem(TEAMS_INDEX_KEY, team.id);
  res.json({ success: true });
}));

app.get('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json((await listUsers()).map(publicUser));
}));

app.get('/api/admin/active-patrols', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const viewer = await getUser(req.user.username);
  const viewerDepartments = await getDepartments(viewer.username);
  const canViewDojIdentity = userHasTeam(viewer, DOJ_TEAM_ID);
  const historyCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const patrols = await Promise.all((await listUsers()).map(async user => {
    const [departments, entries] = await Promise.all([
      getDepartments(user.username),
      getEntries(user.username)
    ]);
    const profile = canViewDojIdentity && userHasTeam(user, DOJ_TEAM_ID) ? getDojProfile(user) : null;
    const summarize = entry => {
      const segments = entrySegments(entry);
      const assignment = [...segments].reverse().find(segment => !segment.endAt) || segments[segments.length - 1];
      const department = findDepartment(departments, entry.departmentId);
      const viewerDepartment = findDepartment(viewerDepartments, entry.departmentId);
      const subdivision = assignment?.subdivisionId
        ? findSubdivision(department, assignment.subdivisionId)
        : null;
      const unitNumber = profile
        ? profile.callsigns[subdivision?.id || ''] || profile.callsigns[department?.id || ''] || ''
        : '';
      return {
        entryId: entry.id,
        username: user.username,
        role: publicUser(user).role,
        departmentName: department?.name || entry.departmentName,
        departmentColor: viewerDepartment?.color || '#4a5568',
        subdivisionName: assignment?.subdivisionId
          ? subdivision?.name || assignment.subdivisionName
          : '',
        startAt: entry.startAt,
        endAt: entry.endAt || null,
        assignmentStartAt: assignment?.startAt || entry.startAt,
        dojIdentity: profile ? [profile.communityName, unitNumber].filter(Boolean).join(' / ') : ''
      };
    };
    return {
      active: entries.find(item => !item.endAt) ? summarize(entries.find(item => !item.endAt)) : null,
      historic: entries
        .filter(entry => entry.endAt && new Date(entry.endAt).getTime() >= historyCutoff)
        .map(summarize)
    };
  }));
  res.json({
    canViewDojIdentity,
    activePatrols: patrols
      .map(item => item.active)
      .filter(Boolean)
      .sort((left, right) => new Date(left.startAt) - new Date(right.startAt)),
    historicPatrols: patrols
      .flatMap(item => item.historic)
      .sort((left, right) => new Date(right.endAt) - new Date(left.endAt))
  });
}));

app.post('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const requested = Array.isArray(req.body.teamIds) ? req.body.teamIds : [DOJ_TEAM_ID];
  const validTeamIds = new Set((await listTeams()).map(team => team.id));
  const teamIds = requested.filter(teamId => validTeamIds.has(teamId) && teamId !== PERSONAL_TEAM_ID);
  const user = await createUser({ ...req.body, teamIds });
  res.status(201).json(publicUser(user));
}));

app.patch('/api/users/:username', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = await getUser(username);
  if (!user) throw new HttpError(404, 'User not found.');
  const requestedUsername = req.body.username ? validateUsername(req.body.username) : username;
  if (requestedUsername !== username && (await getUser(requestedUsername) ||
    await dataClient.exists(departmentKey(requestedUsername)) ||
    await dataClient.exists(entryKey(requestedUsername)) ||
    await dataClient.exists(catalogVersionKey(requestedUsername)))) {
    throw new HttpError(409, 'Username is already in use.');
  }
  const nextRole = req.body.role === 'admin' ? 'admin' : 'user';
  if (user.role === 'admin' && nextRole !== 'admin') {
    const adminCount = (await listUsers()).filter(candidate => candidate.role === 'admin').length;
    if (adminCount <= 1) throw new HttpError(400, 'At least one administrator is required.');
  }
  const updates = { role: nextRole };
  if (Array.isArray(req.body.teamIds)) {
    const validTeamIds = new Set((await listTeams()).map(team => team.id));
    const teamIds = req.body.teamIds.filter(teamId => validTeamIds.has(teamId) && teamId !== PERSONAL_TEAM_ID);
    updates.teamIds = JSON.stringify(teamIds);
    updates.teamOrder = JSON.stringify([
      ...getUserTeamOrder(user).filter(teamId => teamIds.includes(teamId)),
      ...teamIds.filter(teamId => !getUserTeamOrder(user).includes(teamId)),
      PERSONAL_TEAM_ID
    ]);
    updates.disabledTeamIds = JSON.stringify(getUserDisabledTeamIds(user).filter(teamId => teamIds.includes(teamId)));
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
    const credential = hashPassword(String(req.body.password));
    updates.salt = credential.salt;
    updates.passwordHash = credential.hash;
  }
  await dataClient.hSet(userKey(username), updates);
  if (updates.teamIds) await syncUserDepartments(username, { newMembership: true });
  const updatedUser = requestedUsername !== username ? await renameUser(username, requestedUsername) : await getUser(username);
  const safeUser = publicUser(updatedUser);
  res.json(req.user.username === username && updatedUser.username !== username
    ? {
        user: safeUser,
        token: signToken({ username: updatedUser.username, exp: Date.now() + TOKEN_LIFETIME_MS })
      }
    : safeUser);
}));

app.delete('/api/users/:username', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (username === req.user.username) throw new HttpError(400, 'You cannot delete your active account.');
  const user = await getUser(username);
  if (!user) throw new HttpError(404, 'User not found.');
  if (user.role === 'admin') {
    const adminCount = (await listUsers()).filter(candidate => candidate.role === 'admin').length;
    if (adminCount <= 1) throw new HttpError(400, 'At least one administrator is required.');
  }
  await dataClient.del(userKey(username), departmentKey(username), entryKey(username), catalogVersionKey(username));
  await dataClient.sRem(USERS_INDEX_KEY, username);
  res.json({ success: true });
}));

app.get('/api/bootstrap', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  const [departments, entries] = await Promise.all([
    getDepartments(req.user.username),
    getEntries(req.user.username)
  ]);
  const teams = await getOrderedUserTeams(user);
  res.json({
    user: req.user,
    teams,
    dojProfile: userHasTeam(user, DOJ_TEAM_ID) ? getDojProfile(user) : null,
    departments,
    entries: entries.sort((left, right) => new Date(right.startAt) - new Date(left.startAt))
  });
}));

app.get('/api/departments', requireAuth, asyncRoute(async (req, res) => {
  res.json(await getDepartments(req.user.username));
}));

app.post('/api/departments', requireAuth, asyncRoute(async (req, res) => {
  const name = cleanText(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Department name is required.');
  const user = await getUser(req.user.username);
  const teamId = String(req.body.teamId || PERSONAL_TEAM_ID);
  if (!userHasTeam(user, teamId)) throw new HttpError(403, 'Join that team before adding departments to it.');
  const team = await getTeam(teamId);
  await requireDepartmentPermission(req.user, { teamId }, 'department');
  const departments = await getDepartments(req.user.username);
  if (departments.some(department => department.teamId === teamId && normalizeName(department.name) === normalizeName(name))) {
    throw new HttpError(409, 'A department with that name already exists.');
  }
  const department = {
    id: crypto.randomUUID(),
    teamId,
    name,
    enabled: true,
    color: colorValue(req.body.color),
    requiredHours: hoursValue(req.body.requiredHours || 0),
    subdivisions: []
  };
  departments.push(department);
  await saveDepartments(req.user.username, departments);
  await updateSharedTeamTemplate(team, departments);
  res.status(201).json(department);
}));

app.post('/api/departments/defaults', requireAuth, asyncRoute(async (req, res) => {
  await syncUserDepartments(req.user.username, { restorePersonalized: true, newMembership: true });
  res.json(await getDepartments(req.user.username));
}));

app.patch('/api/departments/order', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const departmentIds = Array.isArray(req.body.departmentIds) ? req.body.departmentIds : [];
  if (departmentIds.length !== departments.length ||
    new Set(departmentIds).size !== departments.length ||
    departmentIds.some(id => !departments.some(department => department.id === id))) {
    throw new HttpError(400, 'departmentIds must include every department exactly once.');
  }
  const departmentsById = new Map(departments.map(department => [department.id, department]));
  const orderedDepartments = departmentIds.map(id => departmentsById.get(id));
  const teamIds = new Set(departments.map(department => department.teamId));
  for (const teamId of teamIds) {
    const previousOrder = departments.filter(department => department.teamId === teamId).map(department => department.id);
    const nextOrder = orderedDepartments.filter(department => department.teamId === teamId).map(department => department.id);
    if (JSON.stringify(previousOrder) !== JSON.stringify(nextOrder) && previousOrder.length) {
      await requireDepartmentPermission(req.user, departmentsById.get(previousOrder[0]), 'department');
    }
  }
  await saveDepartments(req.user.username, orderedDepartments);
  res.json(orderedDepartments);
}));

app.patch('/api/departments/:departmentId', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const department = findDepartment(departments, req.params.departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');
  const name = cleanText(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Department name is required.');
  const structureChanged = name !== department.name;
  const team = structureChanged ? await requireDepartmentPermission(req.user, department, 'department') : await getTeam(department.teamId);
  if (departments.some(item => item.id !== department.id && item.teamId === department.teamId && normalizeName(item.name) === normalizeName(name))) {
    throw new HttpError(409, 'A department with that name already exists.');
  }
  department.name = name;
  department.requiredHours = hoursValue(req.body.requiredHours);
  department.color = colorValue(req.body.color || department.color);
  if (typeof req.body.enabled === 'boolean') department.enabled = req.body.enabled;
  await saveDepartments(req.user.username, departments);
  if (structureChanged) await updateSharedTeamTemplate(team, departments);
  res.json(department);
}));

app.delete('/api/departments/:departmentId', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const department = findDepartment(departments, req.params.departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');
  const team = await requireDepartmentPermission(req.user, department, 'department');
  const nextDepartments = departments.filter(department => department.id !== req.params.departmentId);
  await saveDepartments(req.user.username, nextDepartments);
  await updateSharedTeamTemplate(team, nextDepartments);
  res.json({ success: true });
}));

app.post('/api/departments/:departmentId/subdivisions', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const department = findDepartment(departments, req.params.departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');
  const team = await requireDepartmentPermission(req.user, department, 'subdivision');
  const name = cleanText(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Subdivision name is required.');
  if (department.subdivisions.some(subdivision => normalizeName(subdivision.name) === normalizeName(name))) {
    throw new HttpError(409, 'That subdivision already exists in the department.');
  }
  const subdivision = {
    id: crypto.randomUUID(),
    name,
    enabled: true,
    requiredHours: hoursValue(req.body.requiredHours || 0)
  };
  department.subdivisions.push(subdivision);
  await saveDepartments(req.user.username, departments);
  await updateSharedTeamTemplate(team, departments);
  res.status(201).json(subdivision);
}));

app.patch('/api/departments/:departmentId/subdivisions/order', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const department = findDepartment(departments, req.params.departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');
  const team = await requireDepartmentPermission(req.user, department, 'subdivision');
  const subdivisionIds = Array.isArray(req.body.subdivisionIds) ? req.body.subdivisionIds : [];
  if (subdivisionIds.length !== department.subdivisions.length ||
    new Set(subdivisionIds).size !== department.subdivisions.length ||
    subdivisionIds.some(id => !department.subdivisions.some(subdivision => subdivision.id === id))) {
    throw new HttpError(400, 'subdivisionIds must include every subdivision exactly once.');
  }
  const subdivisionsById = new Map(department.subdivisions.map(subdivision => [subdivision.id, subdivision]));
  department.subdivisions = subdivisionIds.map(id => subdivisionsById.get(id));
  await saveDepartments(req.user.username, departments);
  await updateSharedTeamTemplate(team, departments);
  res.json(department);
}));

app.patch('/api/departments/:departmentId/subdivisions/:subdivisionId', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const department = findDepartment(departments, req.params.departmentId);
  const subdivision = findSubdivision(department, req.params.subdivisionId);
  if (!department || !subdivision) throw new HttpError(404, 'Subdivision not found.');
  const name = cleanText(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Subdivision name is required.');
  const structureChanged = name !== subdivision.name;
  const team = structureChanged ? await requireDepartmentPermission(req.user, department, 'subdivision') : await getTeam(department.teamId);
  if (department.subdivisions.some(item => item.id !== subdivision.id && normalizeName(item.name) === normalizeName(name))) {
    throw new HttpError(409, 'That subdivision already exists in the department.');
  }
  subdivision.name = name;
  subdivision.requiredHours = hoursValue(req.body.requiredHours);
  if (typeof req.body.enabled === 'boolean') subdivision.enabled = req.body.enabled;
  await saveDepartments(req.user.username, departments);
  if (structureChanged) await updateSharedTeamTemplate(team, departments);
  res.json(subdivision);
}));

app.delete('/api/departments/:departmentId/subdivisions/:subdivisionId', requireAuth, asyncRoute(async (req, res) => {
  const departments = await getDepartments(req.user.username);
  const department = findDepartment(departments, req.params.departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');
  const team = await requireDepartmentPermission(req.user, department, 'subdivision');
  const length = department.subdivisions.length;
  department.subdivisions = department.subdivisions.filter(subdivision => subdivision.id !== req.params.subdivisionId);
  if (department.subdivisions.length === length) throw new HttpError(404, 'Subdivision not found.');
  await saveDepartments(req.user.username, departments);
  await updateSharedTeamTemplate(team, departments);
  res.json({ success: true });
}));

app.get('/api/entries', requireAuth, asyncRoute(async (req, res) => {
  const entries = await getEntries(req.user.username);
  res.json(entries.sort((left, right) => new Date(right.startAt) - new Date(left.startAt)));
}));

app.post('/api/entries', requireAuth, asyncRoute(async (req, res) => {
  const { department, subdivision } = await resolveAssignment(
    req.user.username,
    req.body.departmentId,
    req.body.subdivisionId
  );
  const entries = await getEntries(req.user.username);
  const startAt = parseDate(req.body.startAt, 'Clock-in time');
  const isManual = Boolean(req.body.endAt);
  const endAt = isManual ? parseDate(req.body.endAt, 'Clock-out time') : null;
  if (endAt && new Date(endAt) <= new Date(startAt)) {
    throw new HttpError(400, 'Clock-out time must be after clock-in time.');
  }
  if (!endAt && entries.some(entry => !entry.endAt)) {
    throw new HttpError(409, 'End the active department patrol before starting another one.');
  }
  const entry = {
    id: crypto.randomUUID(),
    departmentId: department.id,
    departmentName: department.name,
    subdivisionId: subdivision?.id || '',
    subdivisionName: subdivision?.name || '',
    note: cleanText(req.body.note, 200),
    startAt,
    endAt,
    createdAt: new Date().toISOString(),
    segments: [{
      id: crypto.randomUUID(),
      subdivisionId: subdivision?.id || '',
      subdivisionName: subdivision?.name || '',
      startAt,
      endAt
    }]
  };
  entries.push(entry);
  await saveEntries(req.user.username, entries);
  res.status(201).json(entry);
}));

app.post('/api/entries/:entryId/clock-out', requireAuth, asyncRoute(async (req, res) => {
  const entries = await getEntries(req.user.username);
  const entry = entries.find(item => item.id === req.params.entryId);
  if (!entry) throw new HttpError(404, 'Shift not found.');
  if (entry.endAt) throw new HttpError(409, 'This shift is already clocked out.');
  const endAt = parseDate(req.body.endAt, 'Clock-out time');
  if (new Date(endAt) <= new Date(entry.startAt)) {
    throw new HttpError(400, 'Clock-out time must be after clock-in time.');
  }
  entry.endAt = endAt;
  const activeSegment = entry.segments[entry.segments.length - 1];
  if (activeSegment && !activeSegment.endAt) activeSegment.endAt = endAt;
  await saveEntries(req.user.username, entries);
  res.json(entry);
}));

app.post('/api/entries/:entryId/resume', requireAuth, asyncRoute(async (req, res) => {
  const entries = await getEntries(req.user.username);
  const entry = entries.find(item => item.id === req.params.entryId);
  if (!entry) throw new HttpError(404, 'Patrol not found.');
  if (!entry.endAt) throw new HttpError(409, 'This patrol is already active.');
  const endedAt = new Date(entry.endAt).getTime();
  const elapsed = Date.now() - endedAt;
  if (elapsed < 0 || elapsed > PATROL_RESUME_WINDOW_MS) {
    throw new HttpError(409, 'Only patrols ended within the last 5 minutes can be resumed.');
  }
  if (entries.some(item => item.id !== entry.id && !item.endAt)) {
    throw new HttpError(409, 'End the active department patrol before resuming another one.');
  }
  const finalSegment = entry.segments[entry.segments.length - 1];
  if (!finalSegment) throw new HttpError(409, 'This patrol has no assignment to resume.');
  const { department, subdivision } = await resolveAssignment(
    req.user.username,
    entry.departmentId,
    finalSegment.subdivisionId
  );
  entry.departmentName = department.name;
  entry.subdivisionId = subdivision?.id || '';
  entry.subdivisionName = subdivision?.name || '';
  entry.endAt = null;
  finalSegment.subdivisionName = subdivision?.name || '';
  finalSegment.endAt = null;
  await saveEntries(req.user.username, entries);
  res.json(entry);
}));

app.post('/api/entries/:entryId/file-log', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.username);
  if (!userHasTeam(user, DOJ_TEAM_ID)) {
    throw new HttpError(403, 'Join Department of Justice RP to file DOJ shift logs.');
  }
  const entries = await getEntries(req.user.username);
  const entry = entries.find(item => item.id === req.params.entryId);
  if (!entry) throw new HttpError(404, 'Shift not found.');
  if (!entry.endAt) throw new HttpError(409, 'End this patrol before filing its log.');
  const department = findDepartment(await getDepartments(req.user.username), entry.departmentId);
  if (!department || department.teamId !== DOJ_TEAM_ID) {
    throw new HttpError(400, 'Only Department of Justice RP shifts can be filed through DOJ forms.');
  }
  const url = buildDojFormUrl(entry, department, getDojProfile(user));
  entry.formGeneratedAt = new Date().toISOString();
  await saveEntries(req.user.username, entries);
  res.json({ url, entry });
}));

app.post('/api/entries/:entryId/subdivisions', requireAuth, asyncRoute(async (req, res) => {
  const entries = await getEntries(req.user.username);
  const entry = entries.find(item => item.id === req.params.entryId);
  if (!entry) throw new HttpError(404, 'Patrol not found.');
  if (entry.endAt) throw new HttpError(409, 'This patrol has already ended.');
  const subdivisionId = String(req.body.subdivisionId || '');
  const { subdivision } = await resolveAssignment(req.user.username, entry.departmentId, subdivisionId);
  const selectedSubdivisionIds = new Set(entry.segments.map(segment => segment.subdivisionId).filter(Boolean));
  const transitionAt = parseDate(req.body.startAt, 'Subdivision activation time');
  const activeSegment = entry.segments[entry.segments.length - 1];
  if (!activeSegment || activeSegment.endAt) {
    throw new HttpError(409, 'This patrol does not have an active subdivision assignment.');
  }
  if (activeSegment.subdivisionId === subdivisionId) {
    throw new HttpError(409, 'That assignment is already active in this patrol.');
  }
  if (subdivisionId && !selectedSubdivisionIds.has(subdivisionId) && selectedSubdivisionIds.size >= 3) {
    throw new HttpError(409, 'A patrol can include no more than 3 different subdivisions. Start a new department patrol.');
  }
  if (new Date(transitionAt) <= new Date(activeSegment.startAt)) {
    throw new HttpError(400, 'Subdivision activation time must be after the current assignment started.');
  }
  activeSegment.endAt = transitionAt;
  entry.subdivisionId = subdivision?.id || '';
  entry.subdivisionName = subdivision?.name || '';
  entry.segments.push({
    id: crypto.randomUUID(),
    subdivisionId: subdivision?.id || '',
    subdivisionName: subdivision?.name || '',
    startAt: transitionAt,
    endAt: null
  });
  await saveEntries(req.user.username, entries);
  res.status(201).json(entry);
}));

app.patch('/api/entries/:entryId', requireAuth, asyncRoute(async (req, res) => {
  const entries = await getEntries(req.user.username);
  const entry = entries.find(item => item.id === req.params.entryId);
  if (!entry) throw new HttpError(404, 'Shift not found.');
  if (Array.isArray(req.body.segments)) {
    if (!req.body.segments.length) throw new HttpError(400, 'A patrol must have at least one assignment.');
    const departmentId = req.body.departmentId || entry.departmentId;
    const sameDepartment = departmentId === entry.departmentId;
    const normalizedSegments = [];
    const selectedSubdivisionIds = new Set();
    for (let index = 0; index < req.body.segments.length; index += 1) {
      const input = req.body.segments[index];
      const subdivisionId = String(input.subdivisionId || '');
      const wasAssigned = sameDepartment && (!subdivisionId ||
        entry.segments.some(segment => segment.subdivisionId === subdivisionId));
      const { department, subdivision } = await resolveAssignment(
        req.user.username,
        departmentId,
        subdivisionId,
        { allowDisabled: wasAssigned }
      );
      if (subdivisionId) selectedSubdivisionIds.add(subdivisionId);
      if (selectedSubdivisionIds.size > 3) {
        throw new HttpError(409, 'A patrol can include no more than 3 different subdivisions.');
      }
      const startAt = parseDate(input.startAt, `Assignment ${index + 1} start time`);
      if (index > 0 && new Date(startAt) < new Date(normalizedSegments[index - 1].startAt)) {
        throw new HttpError(400, 'Assignment start times must be in chronological order.');
      }
      normalizedSegments.push({
        id: input.id || entry.segments[index]?.id || crypto.randomUUID(),
        subdivisionId: subdivision?.id || '',
        subdivisionName: subdivision?.name || '',
        startAt,
        department
      });
    }
    const collapsedSegments = normalizedSegments.reduce((segments, segment) => {
      if (segments[segments.length - 1]?.subdivisionId === segment.subdivisionId) return segments;
      segments.push(segment);
      return segments;
    }, []);
    const endInput = req.body.endAt === undefined ? entry.endAt : req.body.endAt;
    const endAt = endInput ? parseDate(endInput, 'Clock-out time') : null;
    const finalSegment = collapsedSegments[collapsedSegments.length - 1];
    if (endAt && new Date(endAt) < new Date(finalSegment.startAt)) {
      throw new HttpError(400, 'Clock-out time cannot be before the final assignment started.');
    }
    if (!endAt && entries.some(item => item.id !== entry.id && !item.endAt)) {
      throw new HttpError(409, 'Only one active department patrol can be open at a time.');
    }
    collapsedSegments.forEach((segment, index) => {
      segment.endAt = collapsedSegments[index + 1]?.startAt || endAt;
      delete segment.department;
    });
    const department = (await resolveAssignment(req.user.username, departmentId, '', { allowDisabled: sameDepartment })).department;
    Object.assign(entry, {
      departmentId: department.id,
      departmentName: department.name,
      subdivisionId: finalSegment.subdivisionId,
      subdivisionName: finalSegment.subdivisionName,
      note: cleanText(req.body.note === undefined ? entry.note : req.body.note, 200),
      startAt: collapsedSegments[0].startAt,
      endAt,
      segments: collapsedSegments
    });
    await saveEntries(req.user.username, entries);
    return res.json(entry);
  }
  const subdivisionId = Object.prototype.hasOwnProperty.call(req.body, 'subdivisionId')
    ? req.body.subdivisionId
    : entry.subdivisionId;
  const { department, subdivision } = await resolveAssignment(
    req.user.username,
    req.body.departmentId || entry.departmentId,
    subdivisionId,
    {
      allowDisabled: (req.body.departmentId || entry.departmentId) === entry.departmentId &&
        subdivisionId === entry.subdivisionId
    }
  );
  const startAt = parseDate(req.body.startAt || entry.startAt, 'Clock-in time');
  const endAt = req.body.endAt === null
    ? null
    : req.body.endAt === undefined
      ? entry.endAt
      : parseDate(req.body.endAt, 'Clock-out time');
  if (endAt && new Date(endAt) <= new Date(startAt)) {
    throw new HttpError(400, 'Clock-out time must be after clock-in time.');
  }
  if (!endAt && entries.some(item => item.id !== entry.id && !item.endAt)) {
    throw new HttpError(409, 'Only one active department patrol can be open at a time.');
  }
  Object.assign(entry, {
    departmentId: department.id,
    departmentName: department.name,
    subdivisionId: subdivision?.id || '',
    subdivisionName: subdivision?.name || '',
    note: cleanText(req.body.note === undefined ? entry.note : req.body.note, 200),
    startAt,
    endAt
  });
  entry.segments = [{
    ...entry.segments[0],
    subdivisionId: subdivision?.id || '',
    subdivisionName: subdivision?.name || '',
    startAt,
    endAt
  }];
  await saveEntries(req.user.username, entries);
  res.json(entry);
}));

app.delete('/api/entries/:entryId', requireAuth, asyncRoute(async (req, res) => {
  const entries = await getEntries(req.user.username);
  const nextEntries = entries.filter(entry => entry.id !== req.params.entryId);
  if (nextEntries.length === entries.length) throw new HttpError(404, 'Shift not found.');
  await saveEntries(req.user.username, nextEntries);
  res.json({ success: true });
}));

if (PORTABLE_MODE) {
  app.get('/config.js', (req, res) => {
    res.type('application/javascript').send(`window.TRACKY_CONFIG = ${JSON.stringify({
      APP_NAME: 'TRACKY',
      APP_DESC: 'Department Time Tracking Control Panel',
      TAB_TITLE: 'Tracky',
      API_BASE: ''
    })};`);
  });
  app.use(express.static(STATIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(STATIC_DIR, 'index.html'), error => {
      if (error) next(error);
    });
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Server error.' : error.message });
});

dataClient.connect()
  .then(ensureAdmin)
  .then(() => {
    app.listen(PORT, HOST, () => {
      const address = `http://${PORTABLE_MODE ? HOST : 'localhost'}:${PORT}`;
      console.log(`Tracky backend listening at ${address}`);
      if (PORTABLE_MODE) {
        console.log(`Local application data is stored in ${LOCAL_DATA_FILE}`);
        if (process.env.TRACKY_NO_OPEN !== '1') {
          execFile('cmd.exe', ['/c', 'start', '', address], { windowsHide: true }, error => {
            if (error) console.error('Unable to open Tracky in the default browser:', error.message);
          });
        }
      }
    });
  })
  .catch(error => {
    console.error('Unable to start Tracky backend:', error);
    process.exit(1);
  });

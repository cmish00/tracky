import React, { useEffect, useState } from 'react';

export default function MigrationPanel({ request, onLogout }) {
  const [maintenance, setMaintenance] = useState(false);
  const [backup, setBackup] = useState(null);
  const [summary, setSummary] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const act = async action => {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    request('/api/admin/migration/status').then(result => setMaintenance(result.maintenance)).catch(error => setError(error.message));
  }, []);
  const download = async () => {
    const result = await request('/api/admin/migration/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(result)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `tracky-backup-${result.createdAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const readBackup = event => {
    const file = event.target.files[0];
    setBackup(null); setSummary(null); setConfirmation('');
    if (!file) return;
    act(async () => {
      if (file.size > 50 * 1024 * 1024) throw new Error('Backup exceeds the 50 MB transfer limit.');
      const parsed = JSON.parse(await file.text());
      const result = await request('/api/admin/migration/validate', { method: 'POST', body: JSON.stringify(parsed) });
      setBackup(parsed); setSummary(result);
    });
  };
  return (
    <details className="compact-form migration-panel">
      <summary>Data Transfer</summary>
      <div className="migration-content">
      <p className="muted">Move the complete installation between Docker and Cloudflare. Backups contain all users, password hashes, profiles, teams, settings, and shift logs. Keep these files private.</p>
      <p>Maintenance mode: <strong>{maintenance ? 'ON - changes paused' : 'OFF'}</strong></p>
      <button type="button" disabled={busy} className={maintenance ? 'btn-primary' : 'btn-toggle'} onClick={() => act(async () => {
        const result = await request('/api/admin/migration/maintenance', { method: 'POST', body: JSON.stringify({ enabled: !maintenance }) });
        setMaintenance(result.maintenance);
        setMessage(result.maintenance ? 'Changes are paused. Download your final backup now.' : 'Changes are enabled.');
      })}>{maintenance ? 'Disable Maintenance Mode' : 'Enable Maintenance Mode'}</button>
      <button type="button" disabled={busy} className="btn-primary" onClick={() => act(async () => { await download(); setMessage('Backup downloaded from this installation.'); })}>Download Backup</button>
      <div className="form-group">
        <label htmlFor="migration-backup">Restore Backup</label>
        <input id="migration-backup" type="file" accept=".json,application/json" disabled={busy} onChange={readBackup} />
      </div>
      {summary && <p>{summary.users} users, {summary.teams} teams, {summary.patrols} patrols ({summary.activePatrols} active). Created {backup.createdAt}.</p>}
      {summary?.activePatrols > 0 && <p>Active patrols will continue from their original start times. End them on the source before the final transfer if you do not want moving time counted.</p>}
      {summary && <>
        <p>Restore replaces all Tracky data on this installation. A backup of its current data will download first. Sign in afterward using the imported credentials, then disable maintenance mode.</p>
        <input aria-label="Restore confirmation" placeholder="Type REPLACE to confirm" value={confirmation} onChange={event => setConfirmation(event.target.value)} />
        <button type="button" className="btn-delete" disabled={busy || !maintenance || confirmation !== 'REPLACE'} onClick={() => act(async () => {
          await download();
          await request('/api/admin/migration/import', { method: 'POST', headers: { 'X-Tracky-Restore': 'REPLACE' }, body: JSON.stringify(backup) });
          window.alert('Restore complete. Sign in with the imported password, then disable maintenance mode in Data Transfer.');
          onLogout();
        })}>Replace Data From Backup</button>
      </>}
      {busy && <p role="status">Transferring data...</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}

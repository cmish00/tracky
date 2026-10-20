const crypto = require('crypto');
const express = require('express');

const CONTROL_KEY = 'tracky:migration:maintenance';
const FORMAT = 'tracky-backup';
const MAX_BYTES = 50 * 1024 * 1024;
const isDataKey = key => key.startsWith('tracky:') && key !== CONTROL_KEY;
const checksum = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function validateBackup(backup, username) {
  if (!object(backup) || backup.format !== FORMAT || backup.version !== 1 || !Array.isArray(backup.data)) {
    fail('Choose a Tracky version 1 backup file.');
  }
  if (backup.checksum !== checksum(backup.data)) fail('Backup checksum does not match. The file may be damaged.');
  const records = new Map();
  for (const record of backup.data) {
    if (!object(record) || typeof record.key !== 'string' || !isDataKey(record.key) || records.has(record.key)) {
      fail('Backup contains an invalid or duplicate key.');
    }
    if (record.type === 'string') {
      if (typeof record.value !== 'string') fail('Invalid string record.');
    } else if (record.type === 'hash') {
      if (!object(record.value) || !Object.values(record.value).every(value => typeof value === 'string')) fail('Invalid user record.');
    } else if (record.type === 'set') {
      if (!Array.isArray(record.value) || !record.value.every(value => typeof value === 'string') ||
          new Set(record.value).size !== record.value.length) fail('Invalid index record.');
    } else fail('Unsupported record type.');
    records.set(record.key, record);
  }
  const users = records.get('tracky:users:index');
  const teams = records.get('tracky:teams:index');
  if (users?.type !== 'set' || !users.value.length || teams?.type !== 'set') fail('Backup is missing its user or team index.');
  let patrols = 0;
  let activePatrols = 0;
  for (const name of users.value) {
    const user = records.get(`tracky:user:${name}`);
    if (!/^[a-z0-9_.-]{3,40}$/.test(name) || user?.type !== 'hash' || user.value.username !== name ||
        !['admin', 'user'].includes(user.value.role) || !user.value.salt || !user.value.passwordHash) fail('Backup contains an incomplete user.');
    for (const prefix of ['departments', 'entries']) {
      const record = records.get(`tracky:${prefix}:${name}`);
      if (record?.type !== 'string') fail(`Backup is missing ${prefix} for ${name}.`);
      let value;
      try { value = JSON.parse(record.value); } catch { fail(`Invalid ${prefix} for ${name}.`); }
      if (!Array.isArray(value)) fail(`Invalid ${prefix} for ${name}.`);
      if (prefix === 'entries') {
        if (value.some(entry => !object(entry) || !entry.id || !Number.isFinite(Date.parse(entry.startAt)) ||
            (entry.endAt && !Number.isFinite(Date.parse(entry.endAt))))) fail(`Invalid shift record for ${name}.`);
        patrols += value.length;
        activePatrols += value.filter(entry => !entry.endAt).length;
      }
    }
  }
  for (const id of teams.value) {
    const record = records.get(`tracky:team:${id}`);
    if (record?.type !== 'string') fail('Backup is missing a team.');
    let team;
    try { team = JSON.parse(record.value); } catch { fail('Invalid team record.'); }
    if (!object(team) || team.id !== id || !Array.isArray(team.departments)) fail('Invalid team record.');
  }
  if (records.get(`tracky:user:${username}`)?.value.role !== 'admin') {
    fail(`The backup must contain an administrator named "${username}". Sign in using an administrator username present in the backup.`);
  }
  return { users: users.value.length, teams: teams.value.length, patrols, activePatrols, records: records.size };
}

async function listKeys(client) {
  if (client.trackyKeys) return client.trackyKeys();
  const keys = [];
  for await (const key of client.scanIterator({ MATCH: 'tracky:*', COUNT: 100 })) keys.push(key);
  return keys.filter(isDataKey).sort();
}

async function exportBackup(client) {
  const data = [];
  for (const key of await listKeys(client)) {
    const type = await client.type(key);
    const value = type === 'string' ? await client.get(key)
      : type === 'hash' ? await client.hGetAll(key)
        : type === 'set' ? (await client.sMembers(key)).sort() : null;
    if (value === null) throw new Error(`Cannot export unsupported record ${key}.`);
    data.push({ key, type, value });
  }
  const backup = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), data, checksum: checksum(data) };
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BYTES) fail('Backup exceeds the 50 MB transfer limit.');
  return backup;
}

async function replaceBackup(client, backup) {
  if (client.trackyReplace) return client.trackyReplace(backup.data);
  // One Redis transaction replaces Tracky data while leaving unrelated applications untouched.
  const transaction = client.multi();
  const keys = await listKeys(client);
  for (const key of keys) transaction.del(key);
  for (const { key, type, value } of backup.data) {
    if (type === 'string') transaction.set(key, value);
    if (type === 'hash' && Object.keys(value).length) transaction.hSet(key, value);
    if (type === 'set' && value.length) transaction.sAdd(key, value);
  }
  await transaction.exec();
}

function installMigration(app, client, requireAuth, requireAdmin) {
  let maintenance = false;
  let stateReady;
  let busy = false;
  let active = 0;
  let idle;
  const initialize = () => stateReady ||= client.get(CONTROL_KEY).then(value => { maintenance = value === '1'; });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const exclusive = async fn => {
    if (busy) { const error = new Error('A data transfer is already running.'); error.status = 409; throw error; }
    busy = true;
    try {
      if (active) await new Promise(resolve => { idle = resolve; });
      return await fn();
    } finally { busy = false; }
  };
  // This guard runs before all normal routes, and drains in-flight requests before a snapshot/restore.
  app.use((req, res, next) => {
    initialize().then(() => {
      if (req.path.startsWith('/api/admin/migration/')) return next();
      if (busy || (maintenance && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/api/auth/login')) {
        res.set('Retry-After', '60');
        return res.status(503).json({ error: 'Tracky is temporarily in maintenance mode for a data transfer. Please try again shortly.' });
      }
      active++;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        active--;
        if (!active && idle) { const resolve = idle; idle = null; resolve(); }
      };
      res.once('finish', finish);
      res.once('close', finish);
      next();
    }).catch(next);
  });
  const router = express.Router();
  router.use(requireAuth, requireAdmin);
  router.get('/status', wrap(async (req, res) => {
    await initialize();
    res.json({ maintenance, busy });
  }));
  router.post('/maintenance', express.json({ limit: '1kb' }), wrap(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') fail('Specify whether maintenance mode should be enabled.');
    await exclusive(async () => {
      await client.set(CONTROL_KEY, req.body.enabled ? '1' : '0');
      maintenance = req.body.enabled;
    });
    res.json({ maintenance });
  }));
  router.get('/export', wrap(async (req, res) => {
    const backup = await exclusive(() => exportBackup(client));
    res.set('Cache-Control', 'no-store');
    res.attachment(`tracky-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`).json(backup);
  }));
  router.post('/validate', express.json({ limit: '50mb' }), wrap(async (req, res) => {
    res.json(validateBackup(req.body, req.user.username));
  }));
  router.post('/import', express.json({ limit: '50mb' }), wrap(async (req, res) => {
    if (!maintenance) { const error = new Error('Enable maintenance mode before restoring a backup.'); error.status = 409; throw error; }
    if (req.headers['x-tracky-restore'] !== 'REPLACE') fail('Restore confirmation is required.');
    const summary = validateBackup(req.body, req.user.username);
    await exclusive(() => replaceBackup(client, req.body));
    res.json({ success: true, ...summary });
  }));
  app.use('/api/admin/migration', router);
}

module.exports = { installMigration, validateBackup, exportBackup, replaceBackup, CONTROL_KEY };

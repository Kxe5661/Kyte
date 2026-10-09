// Repeating jobs: each run is a full Kyte agent turn, not a reminder.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./memory');

const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');

function parseEvery(every) {
  const s = String(every || '').trim().toLowerCase();
  const num = parseFloat(s);
  if (/two weeks|biweek|fortnight/.test(s)) return 14 * 86400000;
  if (/week/.test(s)) return (Number.isFinite(num) && num > 0 ? num : 1) * 7 * 86400000;
  if (/day|daily/.test(s)) return (Number.isFinite(num) && num > 0 ? num : 1) * 86400000;
  if (/hour/.test(s)) return (Number.isFinite(num) && num > 0 ? num : 1) * 3600000;
  if (/min/.test(s)) return (Number.isFinite(num) && num > 0 ? num : 1) * 60000;
  if (/month/.test(s)) return 30 * 86400000;
  if (Number.isFinite(num) && /ms$/.test(s)) return num;
  return 86400000;
}

function nextFromClock(clock, from = Date.now()) {
  const m = String(clock || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return from;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function loadJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(jobs, null, 2));
}

function addJob({ prompt, every, clock, label }) {
  const clean = String(prompt || '').trim();
  if (!clean) return { error: 'Need a prompt for the job.' };
  const interval = parseEvery(every || '1 day');
  const now = Date.now();
  const nextRun = clock ? nextFromClock(clock, now) : now + interval;
  const job = {
    id: `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    label: String(label || clean).slice(0, 80),
    prompt: clean,
    every: every || '1 day',
    interval,
    clock: clock || '',
    nextRun,
    lastRun: null,
    enabled: true,
  };
  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);
  return { ok: true, job };
}

function cancelJob(id) {
  const jobs = loadJobs();
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return { error: 'No job with that id.' };
  saveJobs(next);
  return { ok: true, cancelled: id };
}

function dueJobs(now = Date.now()) {
  return loadJobs().filter((j) => j.enabled && j.nextRun <= now);
}

function markRan(id, now = Date.now()) {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.lastRun = now;
  job.nextRun = job.clock ? nextFromClock(job.clock, now + 1000) : now + job.interval;
  saveJobs(jobs);
  return job;
}

function delayJob(id, ms = 30_000) {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.nextRun = Date.now() + ms;
  saveJobs(jobs);
}

function startScheduler(onDue) {
  setInterval(() => {
    for (const job of dueJobs()) onDue(job);
  }, 15_000);
}

module.exports = { addJob, cancelJob, loadJobs, dueJobs, markRan, delayJob, startScheduler, parseEvery };

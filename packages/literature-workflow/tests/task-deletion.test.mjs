import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loadTaskDeletionPlan, previewTaskDeletion, purgeTaskDeletion } from '../lib/task-deletion.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = '12345678-1234-1234-1234-123456789abc';

async function setup(t, { archived = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lit-task-purge-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const stateDir = path.join(temp, 'state');
  const id = 'paper_delete_fixture_01';
  const activeDir = path.join(stateDir, 'jobs', id);
  const jobDir = archived ? path.join(stateDir, '.deleted-jobs', id) : activeDir;
  await fs.mkdir(jobDir, { recursive: true });
  const markdown = Buffer.from('# A local copy\nEvidence stays here.\n');
  const extract = Buffer.from('{"meta":{"title":"Fixture"}}');
  const artifact = Buffer.from('<h1>Local output</h1>');
  const markdownPath = path.join(activeDir, 'full.md');
  const extractPath = path.join(activeDir, 'paper.extract.json');
  const artifactPath = path.join(activeDir, 'deck.html');
  if (archived) {
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, 'full.md'), markdown);
    await fs.writeFile(path.join(jobDir, 'paper.extract.json'), extract);
    await fs.writeFile(path.join(jobDir, 'deck.html'), artifact);
  } else {
    await fs.writeFile(markdownPath, markdown);
    await fs.writeFile(extractPath, extract);
    await fs.writeFile(artifactPath, artifact);
  }
  const sourceDigest = sha(Buffer.from('original input bytes'));
  const zoteroFolder = path.join(temp, 'zotero', `literature-${sourceDigest.slice(0, 12)}`);
  await fs.mkdir(zoteroFolder, { recursive: true });
  const job = {
    id,
    sha256: sourceDigest,
    kind: 'paper',
    status: 'cancelled',
    pdfPath: path.join(activeDir, 'source.pdf'),
    extractPath,
    prepared: { markdownPath },
    artifacts: { design: artifactPath, zoteroFolder },
    source: { kind: 'local', path: path.join(temp, 'original.pdf') },
    publication: { blog: { url: 'https://example.test/paper', status: 'published' }, sheet: { url: 'https://docs.example.test/sheet' } },
  };
  const sourcePdf = Buffer.from('cloned source PDF');
  if (archived) await fs.writeFile(path.join(jobDir, 'source.pdf'), sourcePdf);
  else await fs.writeFile(job.pdfPath, sourcePdf);
  job.pdfPath = path.join(activeDir, 'source.pdf');
  await fs.writeFile(path.join(zoteroFolder, path.basename(markdownPath)), markdown);
  await fs.writeFile(path.join(zoteroFolder, path.basename(extractPath)), extract);
  await fs.mkdir(path.dirname(path.join(stateDir, 'jobs', id, 'job.json')), { recursive: true });
  await fs.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));
  const original = path.join(temp, 'original.pdf');
  await fs.writeFile(original, 'user original document');
  return { temp, stateDir, id, activeDir, jobDir, job, zoteroFolder, original, markdown, extract, artifact };
}

test('preview inventories job-owned files and exact legacy Zotero copies without touching originals or publications', async t => {
  const f = await setup(t);
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  assert.equal(plan.jobId, f.id);
  assert.ok(plan.planToken);
  assert.ok(plan.totalBytes > 0);
  assert.ok(plan.files.some(file => file.kind === 'cloned_source'));
  assert.ok(plan.files.some(file => file.kind === 'job_output' && file.path.endsWith('deck.html')));
  assert.ok(plan.files.some(file => file.kind === 'zotero_copy' && file.path.endsWith('full.md')));
  assert.ok(plan.files.some(file => file.kind === 'zotero_copy' && file.path.endsWith('paper.extract.json')));
  assert.ok(!plan.files.some(file => file.path === f.original));
  assert.deepEqual(plan.externalPublications, [
    { stage: 'blog', url: 'https://example.test/paper', status: 'retained', note: '保留网上发布内容' },
    { stage: 'sheet', url: 'https://docs.example.test/sheet', status: 'retained', note: '保留网上发布内容' },
  ]);
  assert.equal(await fs.readFile(f.original, 'utf8'), 'user original document');
  assert.ok(await fs.stat(path.join(f.jobDir, 'deck.html')));
});

test('purge removes only approved local files and empty generated Zotero folder', async t => {
  const f = await setup(t);
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  const result = await purgeTaskDeletion({ stateDir: f.stateDir, plan, planToken: plan.planToken });
  assert.equal(result.complete, true);
  assert.ok(result.deleted.some(file => file.endsWith('deck.html')));
  assert.ok(result.deleted.some(file => file.endsWith('full.md')));
  assert.equal(await fs.stat(f.jobDir).then(() => true, () => false), false);
  assert.equal(await fs.stat(f.zoteroFolder).then(() => true, () => false), false);
  assert.equal(await fs.readFile(f.original, 'utf8'), 'user original document');
  assert.equal(await fs.stat(path.join(f.stateDir, '.purge-plans')).then(() => true, () => false), false);
});

test('nonempty generated Zotero folders keep unrelated files and do not fail the purge', async t => {
  const f = await setup(t);
  const unrelated = path.join(f.zoteroFolder, 'user-note.txt');
  await fs.writeFile(unrelated, 'keep');
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  const result = await purgeTaskDeletion({ stateDir: f.stateDir, plan, planToken: plan.planToken });
  assert.equal(result.complete, true);
  assert.ok(result.preservedDirectories.includes(f.zoteroFolder));
  assert.ok(result.warnings.some(message => message.includes('仍包含其他文件')));
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
});

test('a stale hash or a new task file rejects the whole plan before any unlink', async t => {
  const f1 = await setup(t);
  const plan1 = await previewTaskDeletion({ stateDir: f1.stateDir, job: f1.job, jobDir: f1.jobDir, allJobs: [f1.job] });
  await fs.writeFile(path.join(f1.jobDir, 'deck.html'), 'changed after review');
  await assert.rejects(purgeTaskDeletion({ stateDir: f1.stateDir, plan: plan1, planToken: plan1.planToken }), /内容已变化/);
  assert.equal(await fs.readFile(path.join(f1.jobDir, 'full.md'), 'utf8'), f1.markdown.toString());
  assert.equal(await fs.readFile(path.join(f1.zoteroFolder, 'full.md'), 'utf8'), f1.markdown.toString());

  const f2 = await setup(t);
  const plan2 = await previewTaskDeletion({ stateDir: f2.stateDir, job: f2.job, jobDir: f2.jobDir, allJobs: [f2.job] });
  await fs.writeFile(path.join(f2.jobDir, 'new-output.bin'), 'not in approved inventory');
  await assert.rejects(purgeTaskDeletion({ stateDir: f2.stateDir, plan: plan2, planToken: plan2.planToken }), /新增的文件/);
  assert.equal(await fs.readFile(path.join(f2.jobDir, 'deck.html'), 'utf8'), f2.artifact.toString());
});

test('reused or shared Zotero copies are preserved with warnings', async t => {
  const f = await setup(t);
  const reusedPath = path.join(f.zoteroFolder, 'full.md');
  const ownedPath = path.join(f.zoteroFolder, 'owned.md');
  await fs.writeFile(ownedPath, 'job created');
  f.job.localCopies = [
    { path: reusedPath, sha256: sha(f.markdown), createdByJob: false },
    { path: ownedPath, sha256: sha('job created'), createdByJob: true },
  ];
  await fs.writeFile(path.join(f.jobDir, 'job.json'), JSON.stringify(f.job, null, 2));
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  assert.ok(!plan.files.some(file => file.path === reusedPath));
  assert.ok(plan.files.some(file => file.path === ownedPath));
  assert.ok(plan.warnings.some(message => message.includes('没有标记为本任务创建')));

  const other = { id: 'paper_other_fixture_01', extractPath: path.join(f.stateDir, 'jobs', 'paper_other_fixture_01', 'paper.extract.json'), artifacts: { zoteroFolder: f.zoteroFolder } };
  const shared = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job, other] });
  const sharedExtract = path.join(f.zoteroFolder, 'paper.extract.json');
  assert.ok(!shared.files.some(file => file.path === sharedExtract));
  assert.ok(shared.warnings.some(message => message.includes('其他任务仍引用')));
});

test('only hash-matching UUID uploads and downloaded cache entries are included', async t => {
  const f = await setup(t);
  const uploadDir = path.join(f.stateDir, 'uploads'), downloadsDir = path.join(f.stateDir, 'downloads');
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  const validUpload = path.join(uploadDir, uuid);
  const validCache = path.join(downloadsDir, `${uuid}.pdf`);
  const invalidUpload = path.join(uploadDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const bytes = Buffer.from('original input bytes');
  await fs.writeFile(validUpload, bytes);
  await fs.writeFile(validCache, bytes);
  await fs.writeFile(invalidUpload, 'different input');
  f.job.source.uploadPath = invalidUpload;
  f.job.source.cachePath = validCache;
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  assert.ok(!plan.files.some(file => file.path === invalidUpload));
  assert.ok(plan.files.some(file => file.path === validCache && file.kind === 'download_cache'));
  assert.ok(!plan.files.some(file => file.path === invalidUpload));
  assert.ok(plan.warnings.some(message => message.includes('摘要与任务不一致')));
  f.job.source.uploadPath = validUpload;
  const validPlan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  assert.ok(validPlan.files.some(file => file.path === validUpload && file.kind === 'tracked_upload'));
});

test('archive moves after preview are remapped and missing approved files are retry-safe', async t => {
  const f = await setup(t);
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.activeDir, allJobs: [f.job] });
  const archive = path.join(f.stateDir, '.deleted-jobs', f.id);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.rename(f.activeDir, archive);
  await fs.unlink(path.join(archive, 'deck.html'));
  const result = await purgeTaskDeletion({ stateDir: f.stateDir, plan, planToken: plan.planToken });
  assert.equal(result.complete, true);
  assert.ok(result.missing.some(file => file.endsWith('deck.html')));
  assert.equal(await fs.stat(archive).then(() => true, () => false), false);
  assert.equal(await fs.stat(f.zoteroFolder).then(() => true, () => false), false);
});

test('directory junctions inside a job are rejected without touching their targets', async t => {
  const f = await setup(t);
  const outside = path.join(f.temp, 'outside');
  const junction = path.join(f.jobDir, 'linked-output');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  try { await fs.symlink(outside, junction, 'junction'); }
  catch (error) { t.skip(`symlink creation is unavailable: ${error.code || error.message}`); return; }
  await assert.rejects(previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] }), /符号链接或目录联接/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('saved approved plans can be recovered for a repeat UI action', async t => {
  const f = await setup(t);
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  const planDirectory = path.join(f.stateDir, '.purge-plans');
  await fs.mkdir(planDirectory, { recursive: true });
  await fs.writeFile(path.join(planDirectory, `${f.id}.json`), JSON.stringify(plan));
  const recovered = await loadTaskDeletionPlan({ stateDir: f.stateDir, jobId: f.id });
  assert.equal(recovered.planToken, plan.planToken);
  const result = await purgeTaskDeletion({ stateDir: f.stateDir, plan: recovered, planToken: recovered.planToken });
  assert.equal(result.complete, true);
  assert.equal(await loadTaskDeletionPlan({ stateDir: f.stateDir, jobId: f.id }), null);
});

test('an operation lock blocks purge before removing any planned file', async t => {
  const f = await setup(t);
  const plan = await previewTaskDeletion({ stateDir: f.stateDir, job: f.job, jobDir: f.jobDir, allJobs: [f.job] });
  await fs.writeFile(path.join(f.jobDir, 'operation.lock'), '{"pid":1}');
  await assert.rejects(purgeTaskDeletion({ stateDir: f.stateDir, plan, planToken: plan.planToken }), /任务锁仍存在/);
  assert.ok(await fs.stat(path.join(f.jobDir, 'deck.html')));
  assert.ok(await fs.stat(path.join(f.zoteroFolder, 'full.md')));
});

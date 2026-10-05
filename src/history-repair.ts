import type { HistoryRow } from './history.ts';
export type Finding = { id: number; reason: string; watched_at: string; release?: string; type: 'movie'|'episode'; mediaId?: number; runtime?: number; title?: string };
export type Repair = { finding: Finding; before: {id:number; watched_at:string}[]; target: string; phase:'prepared'|'adding'|'added'|'removing'; replacement?:number };
export type RepairIO = {
  read: (finding:Finding)=>Promise<HistoryRow[]>;
  post: (path:string,body:object)=>Promise<unknown>;
  save: (value:Repair)=>Promise<void>;
  complete: (value:Repair)=>Promise<void>;
};
export async function repairHistory(finding:Finding, io:RepairIO, pending?:Repair) {
  let job=pending;
  if(!job) {
    const release=Date.parse(finding.release ?? '');
    if(!['placeholder','before_release'].includes(finding.reason) || !Number.isSafeInteger(finding.mediaId) ||
       !Number.isFinite(release) || release>Date.now() || release<Date.UTC(1970,0,2)) return {status:'review' as const};
    const before=await io.read(finding);
    const original=before.find(x=>x.id===finding.id);
    if(!original || original.watched_at!==finding.watched_at) return {status:'changed' as const};
    // Trakt release-date watches use the first-air time plus runtime for episodes.
    let target=release+(finding.type==='episode'?Math.max(0,finding.runtime??0)*60000:0);
    const occupied=new Set(before.map(x=>Date.parse(x.watched_at)));
    while(occupied.has(target)) target+=60000;
    if(target-release>=86400000 || target>Date.now()) return {status:'review' as const};
    job={finding,before:before.map(x=>({id:x.id,watched_at:x.watched_at})),target:new Date(target).toISOString(),phase:'prepared'};
    await io.save(job);
  }
  const live=await io.read(job.finding);
  const beforeIds=new Set(job.before.map(x=>x.id));
  const added=live.filter(x=>!beforeIds.has(x.id));
  const matches=added.filter(x=>Date.parse(x.watched_at)===Date.parse(job.target));
  if(matches.length>1 || added.some(x=>Date.parse(x.watched_at)!==Date.parse(job.target))) throw Error('Concurrent watch during history repair; review required');
  for(const old of job.before) {
    if(old.id===job.finding.id) continue;
    if(!live.some(x=>x.id===old.id && x.watched_at===old.watched_at)) throw Error('Unrelated watch changed during repair');
  }
  const original=live.find(x=>x.id===job!.finding.id);
  if(original && original.watched_at!==job.finding.watched_at) throw Error('Original watch changed during repair');
  if(!matches.length) {
    if(job.phase!=='prepared') throw Error('Uncertain history addition; retained original and journal for review');
    if(!original) throw Error('Original watch removed concurrently');
    job.phase='adding'; await io.save(job);
    // Never blindly retry an uncertain add: the saved journal is reconciled on the next run.
    await io.post('/sync/history',{[job.finding.type+'s']:[{ids:{trakt:job.finding.mediaId},watched_at:job.target}]});
    const check=await io.read(job.finding);
    const candidates=check.filter(x=>!beforeIds.has(x.id) && Date.parse(x.watched_at)===Date.parse(job!.target));
    if(candidates.length!==1 || check.length!==job.before.length+1 || job.before.some(old=>!check.some(x=>x.id===old.id && x.watched_at===old.watched_at))) throw Error('Replacement verification failed; original retained');
    job.replacement=candidates[0].id; job.phase='added'; await io.save(job);
  } else {
    if(job.replacement && job.replacement!==matches[0].id) throw Error('Replacement identity changed');
    job.replacement=matches[0].id;
  }
  if(original) {
    job.phase='removing'; await io.save(job);
    await io.post('/sync/history/remove',{ids:[job.finding.id]});
  }
  const after=await io.read(job.finding);
  if(after.some(x=>x.id===job!.finding.id) || after.length!==job.before.length ||
     !after.some(x=>x.id===job!.replacement && Date.parse(x.watched_at)===Date.parse(job!.target)) ||
     job.before.some(old=>old.id!==job!.finding.id && !after.some(x=>x.id===old.id && x.watched_at===old.watched_at))) throw Error('Final history repair verification failed');
  await io.complete(job);
  return {status:'fixed' as const, original:job.finding.id,replacement:job.replacement,target:job.target};
}

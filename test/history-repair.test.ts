import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repairHistory, type Repair, type Finding} from '../src/history-repair.ts';
import type {HistoryRow} from '../src/history.ts';
const finding:Finding={id:1,type:'movie',mediaId:42,reason:'placeholder',watched_at:'1970-01-01T00:00:00.000Z',release:'2020-01-01'};
function fixture() {
 let rows:HistoryRow[]=[{id:1,type:'movie',watched_at:finding.watched_at,movie:{title:'Example',ids:{trakt:42}}},{id:2,type:'movie',watched_at:'2020-01-01T00:00:00.000Z',movie:{title:'Example',ids:{trakt:42}}}];
 let saved:Repair|undefined, done:Repair|undefined,adds=0,removes=0;
 const io={read:async()=>structuredClone(rows),save:async(j:Repair)=>{saved=structuredClone(j)},complete:async(j:Repair)=>{done=structuredClone(j)},post:async(path:string,body:any)=>{
  if(path.endsWith('/remove')){removes++;rows=rows.filter(x=>!body.ids.includes(x.id));}
  else {adds++;rows.push({id:3,type:'movie',watched_at:body.movies[0].watched_at,movie:{title:'Example',ids:{trakt:42}}});}
 }};
 return {io,get saved(){return saved},get done(){return done},get rows(){return rows},get adds(){return adds},get removes(){return removes}};
}
test('preserves repeat watches and chooses an unoccupied release timestamp',async()=>{
 const f=fixture();const r=await repairHistory(finding,f.io);
 assert.equal(r.status,'fixed');assert.equal(f.rows.length,2);assert.equal(f.rows.find(x=>x.id===2)?.watched_at,'2020-01-01T00:00:00.000Z');
 assert.equal(f.done?.target,'2020-01-01T00:01:00.000Z');assert.equal(f.removes,1);
});
test('lost add response resumes without duplicate addition',async()=>{
 const f=fixture(),post=f.io.post;
 f.io.post=async(p,b)=>{await post(p,b);throw Error('lost response')};
 await assert.rejects(repairHistory(finding,f.io),/lost response/);assert.equal(f.removes,0);
 f.io.post=post;await repairHistory(finding,f.io,f.saved);assert.equal(f.adds,1);assert.equal(f.removes,1);
});
test('uncertain add absent from history stops without retrying or deleting',async()=>{
 const f=fixture();f.io.post=async()=>{throw Error('timeout')};
 await assert.rejects(repairHistory(finding,f.io));
 await assert.rejects(repairHistory(finding,f.io,f.saved),/Uncertain/);assert.equal(f.removes,0);assert.equal(f.rows.length,2);
});
test('lost delete response reconciles successfully without deleting other watches',async()=>{
 const f=fixture(),post=f.io.post;f.io.post=async(p,b)=>{await post(p,b);if(p.endsWith('/remove'))throw Error('lost response')};
 await assert.rejects(repairHistory(finding,f.io),/lost response/);
 f.io.post=post;await repairHistory(finding,f.io,f.saved);assert.equal(f.removes,1);assert.equal(f.rows.length,2);
});
test('missing or future releases are left for review',async()=>{
 const f=fixture();assert.equal((await repairHistory({...finding,release:undefined},f.io)).status,'review');
 assert.equal((await repairHistory({...finding,release:'2999-01-01'},f.io)).status,'review');assert.equal(f.adds,0);
});
test('concurrent changes stop before original is removed',async()=>{
 const f=fixture(),post=f.io.post;f.io.post=async(p,b)=>{await post(p,b);f.rows.push({id:4,type:'movie',watched_at:'2022-01-01',movie:{title:'Example'}})};
 await assert.rejects(repairHistory(finding,f.io),/verification failed/);assert.equal(f.removes,0);
});

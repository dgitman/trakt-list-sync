import {test} from 'node:test';
import assert from 'node:assert/strict';
import {issue,scanHistory} from '../src/history.ts';
const movie=(id:number,date:string)=>({id,type:'movie' as const,watched_at:date,movie:{title:'Example',released:'2020-01-01'}});
test('detects epoch, pre-release and invalid dates while accepting release-day watches',()=>{
 assert.equal(issue(movie(1,'1970-01-01T00:00:00Z'))?.reason,'placeholder');
 assert.equal(issue(movie(2,'2019-12-31T23:59:59Z'))?.reason,'before_release');
 assert.equal(issue(movie(3,'2020-01-01T00:00:00Z')),null);
 assert.equal(issue(movie(4,'invalid'))?.reason,'invalid_date');
 assert.equal(issue({id:5,type:'episode',watched_at:'2020-01-01T19:00:00Z',episode:{title:'ep',first_aired:'2020-01-01T20:00:00Z'}})?.reason,'before_release');
});
const response=(rows:unknown[],count:number,pages:number)=>Response.json(rows,{headers:{'x-pagination-item-count':String(count),'x-pagination-page-count':String(pages)}});
test('reads all pages and counts unknown release metadata',async()=>{
 let calls=0;
 const r=await scanHistory(async()=>++calls===1?response([movie(1,'1970-01-01T00:00:00Z')],2,2):response([{id:2,type:'movie',watched_at:'2021-01-01',movie:{title:'Unknown'}}],2,2),'2026-09-20');
 assert.equal(calls,2);assert.equal(r.scanned,2);assert.equal(r.issues.length,1);assert.equal(r.unknownRelease,1);
});
test('rejects missing pages, duplicates, and changing pagination',async()=>{
 await assert.rejects(scanHistory(async()=>response([],1,1),'x'),/Incomplete/);
 await assert.rejects(scanHistory(async()=>response([movie(1,'2021-01-01'),movie(1,'2021-01-01')],2,1),'x'),/Duplicate/);
 let n=0;await assert.rejects(scanHistory(async()=>response([movie(++n,'2021-01-01')],n===1?2:3,2),'x'),/changed/);
});

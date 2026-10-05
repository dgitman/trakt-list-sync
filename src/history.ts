export type HistoryRow = {
  id: number; type: 'movie' | 'episode'; watched_at: string;
  movie?: { title: string; released?: string; ids?: {trakt:number} };
  episode?: { title: string; first_aired?: string; season?: number; number?: number; ids?: {trakt:number}; runtime?:number };
  show?: { title: string };
};
export function issue(row: HistoryRow) {
  const watched = Date.parse(row.watched_at);
  const release = row.type === 'movie' ? row.movie?.released : row.episode?.first_aired;
  const released = release ? Date.parse(release) : NaN;
  // Unix epoch placeholders may be displayed as December 31, 1969 locally.
  const reason = !Number.isFinite(watched) ? 'invalid_date' :
    watched >= Date.UTC(1969,11,31) && watched < Date.UTC(1970,0,2) ? 'placeholder' :
    Number.isFinite(released) && watched < released ? 'before_release' : null;
  return reason ? { id: row.id, reason, type:row.type, mediaId:(row.type==='movie'?row.movie:row.episode)?.ids?.trakt, runtime:row.episode?.runtime, title: row.show?.title ?? row.movie?.title ?? row.episode?.title,
    season: row.episode?.season, episode: row.episode?.number, watched_at: row.watched_at, release } : null;
}
export async function scanHistory(api: (path: string) => Promise<Response>, cutoff: string) {
  let pages = 1, count: number | undefined;
  const seen = new Set<number>();
  const issues: NonNullable<ReturnType<typeof issue>>[] = [];
  let unknownRelease = 0;
  for(let page=1;page<=pages;page++) {
    const response = await api('/sync/history?extended=full&limit=250&page='+page+'&end_at='+encodeURIComponent(cutoff));
    const pc = response.headers.get('x-pagination-page-count');
    const ic = response.headers.get('x-pagination-item-count');
    if(pc === null || ic === null) throw Error('History pagination metadata missing');
    const total=Number(ic), nextPages=Math.max(1,Number(pc));
    if(!Number.isInteger(total) || total<0 || !Number.isInteger(nextPages) || nextPages>1000 ||
       (count!==undefined && (count!==total || pages!==nextPages))) throw Error('History changed during scan');
    count=total; pages=nextPages;
    const rows = await response.json() as HistoryRow[];
    if(!Array.isArray(rows)) throw Error('Invalid history response');
    for(const row of rows) {
      if(!Number.isSafeInteger(row.id) || seen.has(row.id)) throw Error('Duplicate or invalid history ID');
      if(!['movie','episode'].includes(row.type)) throw Error('Unsupported history media');
      seen.add(row.id);
      const found=issue(row); if(found) issues.push(found);
      const release=row.type==='movie'?row.movie?.released:row.episode?.first_aired;
      if(!release || !Number.isFinite(Date.parse(release))) unknownRelease++;
    }
  }
  if(seen.size!==count) throw Error('Incomplete history scan');
  return {scanned:seen.size, unknownRelease, issues};
}

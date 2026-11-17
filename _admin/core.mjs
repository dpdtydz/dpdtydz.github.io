import YAML from 'yaml';

export const REPOSITORY = 'dpdtydz/dpdtydz.github.io';
export const BRANCH = 'master';
export const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const today = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part => [part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export const encode64 = value => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index,index+8192));
  return btoa(binary);
};
export const decode64 = value => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g,'')), character => character.charCodeAt(0)));
export function splitDocument(source) {
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return {document:YAML.parseDocument(match ? match[1] : ''),body:match ? source.slice(match[0].length) : source};
}
export function parsePost(source,path='') {
  const {document,body} = splitDocument(source);
  if (document.errors.length) throw Error('글의 YAML 머리말을 해석할 수 없습니다. 원본을 확인해주세요.');
  const data = document.toJS() || {};
  const filename = path.split('/').pop() || '';
  return {title:data.title || '',subtitle:data.subtitle || '',tags:Array.isArray(data.tags)?data.tags.join(', '):String(data.tags || ''),body,date:filename.slice(0,10) || today(),slug:filename.replace(/^\d{4}-\d{2}-\d{2}-/,'').replace(/\.(md|markdown|html)$/i,''),published:data.published !== false};
}
export function postSource(original,fields,published=true) {
  if (!fields.title.trim() || !fields.body.trim()) throw Error('제목과 본문을 입력해주세요.');
  const {document} = splitDocument(original);
  if (document.errors.length) throw Error('원본 머리말에 오류가 있어 덮어쓰지 않았습니다.');
  if (!document.has('layout')) document.set('layout','post');
  document.set('title',fields.title.trim());
  fields.subtitle.trim() ? document.set('subtitle',fields.subtitle.trim()) : document.delete('subtitle');
  document.set('tags',[...new Set(fields.tags.split(',').map(tag=>tag.trim()).filter(Boolean))]);
  document.set('published',published);
  return `---\n${String(document).trimEnd()}\n---\n\n${fields.body.replace(/^\s*\n/,'').trimEnd()}\n`;
}
export function newPostPath(fields) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date) || Number.isNaN(Date.parse(`${fields.date}T00:00:00Z`)) || new Date(`${fields.date}T00:00:00Z`).toISOString().slice(0,10)!==fields.date) throw Error('날짜를 확인해주세요.');
  if (fields.date > today()) throw Error('미래 날짜의 글은 자동으로 발행되지 않습니다. 오늘 또는 이전 날짜를 선택해주세요.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.slug)) throw Error('주소는 영문 소문자·숫자·하이픈으로 입력해주세요.');
  return `_posts/${fields.date}-${fields.slug}.md`;
}
export function allowedPath(path) {
  if (typeof path !== 'string' || path.split('/').some(part=>part==='..'||part==='.'||part==='')) return false;
  return /^_posts\/(?:[^/]+\/)*\d{4}-\d{2}-\d{2}-[^/]+\.(md|markdown|html)$/i.test(path)
    || /^assets\/img\/uploads\/[a-z0-9_.-]+\.(png|jpg|jpeg|webp|gif)$/i.test(path)
    || ['aboutme.md','_data/projects.yml','_includes/career.html','_includes/skills.html','index.html','work.html','_config.yml'].includes(path);
}

export class GitHubClient {
  constructor(token,fetcher=fetch) { this.token=token; this.fetcher=fetcher; this.controller=new AbortController(); }
  disconnect() { this.token=''; this.controller.abort(); }
  async request(endpoint,method='GET',body) {
    const response = await this.fetcher(`https://api.github.com${endpoint}`,{
      method,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,'X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:this.controller.signal,cache:'no-store',credentials:'omit'
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) {
      const message = response.status===401?'GitHub 인증이 만료되었거나 올바르지 않습니다. 다시 연결해주세요.':response.status===403?'GitHub 권한이 부족하거나 API 요청 한도를 초과했습니다. 토큰 권한과 잠시 후 재시도를 확인해주세요.':response.status===409||response.status===422?'원격 내용이 변경되었거나 저장 요청이 충돌했습니다. 초안을 보관하고 최신 내용을 다시 불러와주세요.':`GitHub 요청에 실패했습니다 (${response.status}).`;
      const error = Error(message); error.status=response.status; throw error;
    }
    return data;
  }
  async connect() {
    const [user,repository] = await Promise.all([this.request('/user'),this.request(`/repos/${REPOSITORY}`)]);
    if (user.login?.toLowerCase()!=='dpdtydz' || !repository.permissions?.push) throw Error('이 저장소를 관리하는 dpdtydz 계정의 토큰으로 연결해주세요.');
    return user;
  }
  async snapshot() {
    const ref = await this.request(`/repos/${REPOSITORY}/git/ref/heads/${BRANCH}`);
    const commit = await this.request(`/repos/${REPOSITORY}/git/commits/${ref.object.sha}`);
    const result = await this.request(`/repos/${REPOSITORY}/git/trees/${commit.tree.sha}?recursive=1`);
    if (result.truncated) throw Error('저장소 파일 목록이 너무 커서 안전하게 불러오지 못했습니다.');
    return {head:ref.object.sha,tree:commit.tree.sha,files:new Map(result.tree.filter(file=>file.type==='blob').map(file=>[file.path,file]))};
  }
  async read(path,snapshot) {
    if (!allowedPath(path)) throw Error('관리 대상 파일이 아닙니다.');
    const file=snapshot.files.get(path);
    if (!file) throw Error('원격에서 파일을 찾을 수 없습니다. 목록을 새로고침해주세요.');
    const blob=await this.request(`/repos/${REPOSITORY}/git/blobs/${file.sha}`);
    return {path,sha:file.sha,raw:decode64(blob.content)};
  }
  async commit(changes,message) {
    if (!changes.length || changes.some(change=>!allowedPath(change.path))) throw Error('저장할 파일 경로가 올바르지 않습니다.');
    if (new Set(changes.map(change=>change.path)).size!==changes.length) throw Error('같은 파일이 중복 지정되었습니다.');
    const current=await this.snapshot();
    for (const change of changes) {
      const actual=current.files.get(change.path)?.sha || null;
      if (actual!==(change.sha || null)) throw Error(`다른 곳에서 ${change.path} 파일이 변경되었습니다. 초안을 보관하고 최신 내용을 다시 불러와주세요.`);
    }
    const entries=[];
    for (const change of changes) {
      if (change.remove) entries.push({path:change.path,mode:'100644',type:'blob',sha:null});
      else if (change.base64) {
        const blob=await this.request(`/repos/${REPOSITORY}/git/blobs`,'POST',{content:change.base64,encoding:'base64'});
        entries.push({path:change.path,mode:'100644',type:'blob',sha:blob.sha});
      } else entries.push({path:change.path,mode:'100644',type:'blob',content:change.raw});
    }
    const tree=await this.request(`/repos/${REPOSITORY}/git/trees`,'POST',{base_tree:current.tree,tree:entries});
    const commit=await this.request(`/repos/${REPOSITORY}/git/commits`,'POST',{message,tree:tree.sha,parents:[current.head]});
    // A concurrent writer is rejected by GitHub; never force or silently retry a write.
    await this.request(`/repos/${REPOSITORY}/git/refs/heads/${BRANCH}`,'PATCH',{sha:commit.sha,force:false});
    return commit;
  }
}

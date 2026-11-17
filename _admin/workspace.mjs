import YAML from 'yaml';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import {GitHubClient,REPOSITORY,BRANCH,esc,today,encode64,splitDocument,parsePost,postSource,newPostPath} from './core.mjs';

const markdown=new MarkdownIt({html:true,linkify:true});
const POST_PATTERN=/^_posts\/(?:[^/]+\/)*\d{4}-\d{2}-\d{2}-.+\.(md|markdown|html)$/i;
const fileKinds={about:'aboutme.md',projects:'_data/projects.yml',career:'_includes/career.html',skills:'_includes/skills.html',home:'index.html',work:'work.html',analytics:'_config.yml'};
const labels={overview:'현황',posts:'글 관리',drafts:'이 브라우저의 초안',about:'소개',projects:'성과',career:'경력',skills:'기술',home:'홈 문구',work:'포트폴리오 문구',analytics:'방문 통계 연결'};
const text=node=>node?.textContent?.trim() || '';
const multiline=node=>{if(!node)return '';const copy=node.cloneNode(true);copy.querySelectorAll('br').forEach(br=>br.replaceWith('\n'));return copy.textContent.trim();};
const dom=source=>new DOMParser().parseFromString(source,'text/html');
const lines=value=>esc(value).replace(/\n/g,'<br>');
const field=(label,name,value,options={})=>`<label class="admin-field${options.wide?' wide':''}"><span>${esc(label)}</span>${options.area?`<textarea data-field="${esc(name)}" rows="${options.rows || 4}"${options.code?' class="code-input"':''}>${esc(value)}</textarea>`:`<input data-field="${esc(name)}" type="${options.type || 'text'}" value="${esc(value)}"${options.readonly?' readonly':''}>`}${options.help?`<small>${esc(options.help)}</small>`:''}</label>`;
const button=(label,action,extra='')=>`<button type="button" data-action="${action}" ${extra}>${label}</button>`;

export async function mount({root,vault,lock}) {
  const stored=await vault.read();
  const state={view:'overview',drafts:stored.drafts || {},manifest:{posts:[],projects:[]},client:null,user:null,snapshot:null,cache:new Map(),doc:null,busy:false,message:'',error:false,postQuery:'',lastCommit:null,postOverrides:new Map()};
  let draftTimer,previewTimer,lastActivity=Date.now();
  root.innerHTML=`<div class="admin-shell"><aside class="admin-sidebar"><a class="admin-brand" href="/">이호상<span>.</span></a><p class="sidebar-caption">superhome</p><nav aria-label="관리 메뉴">${Object.entries(labels).map(([id,label])=>button(esc(label),'view',`data-view="${id}"`)).join('')}</nav><div class="sidebar-bottom">${button('GitHub 연결','connect')}${button('잠금 / 로그아웃','lock')}</div></aside><div class="admin-main"><header class="admin-topbar"><div><p class="admin-eyebrow">내 기록 관리</p><h1 id="workspace-title">현황</h1></div><div class="admin-top-actions"><span id="connection-state">GitHub 미연결</span>${button('새 글 쓰기','new-post','class="admin-primary"')}</div></header><div id="admin-status" class="admin-status" role="status" aria-live="polite" hidden></div><div id="admin-screen"></div></div></div>
    <dialog id="github-dialog" class="admin-dialog"><form id="github-form"><div class="dialog-heading"><h2>GitHub 연결</h2>${button('닫기','close-dialog','data-dialog="github-dialog"')}</div><p>이 저장소에만 접근하는 Fine-grained token을 연결하세요. 토큰은 현재 탭의 메모리에만 보관하고, 로그아웃하거나 새로고침하면 지웁니다.</p><ol><li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub에서 토큰 만들기 ↗</a></li><li>저장소: <strong>dpdtydz.github.io</strong></li><li>Repository permissions: <strong>Contents → Read and write</strong></li><li>저장소 방문 통계도 보려면 선택적으로 <strong>Administration → Read</strong></li></ol><label class="admin-field"><span>GitHub 토큰</span><input id="github-token" type="password" autocomplete="off" required></label><p class="dialog-error" id="connect-error" role="alert" hidden></p><button type="submit" class="admin-primary">연결</button></form></dialog>
    <dialog id="confirm-dialog" class="admin-dialog"><form id="confirm-form"><h2 id="confirm-title"></h2><p id="confirm-description"></p><label class="admin-field" id="confirm-label"><span>삭제할 글의 제목을 입력해주세요.</span><input id="confirm-value" autocomplete="off"></label><div class="dialog-actions"><button type="button" id="confirm-cancel">취소</button><button type="submit" id="confirm-submit" class="admin-danger">삭제</button></div></form></dialog>`;
  const $=selector=>root.querySelector(selector);
  function notice(message,error=false) {state.message=message;state.error=error;const element=$('#admin-status');element.hidden=!message;element.textContent=message;element.classList.toggle('is-error',error);}
  function toolbar() {
    $('#connection-state').textContent=state.user?`GitHub · ${state.user.login}`:'GitHub 미연결';
    root.setAttribute('aria-busy',String(state.busy));
    root.querySelectorAll('button,input,textarea,select').forEach(element=>{element.disabled=state.busy || (element.hasAttribute('data-needs-github')&&!state.client);});
    root.querySelectorAll('[data-action="view"]').forEach(element=>element.setAttribute('aria-current',String(element.dataset.view===state.view)));
  }
  async function task(callback) {
    if (state.busy) return;
    state.busy=true;toolbar();
    try {await callback();} catch(error) {if(error.name!=='AbortError')notice(error.message || '작업을 완료하지 못했습니다.',true);}
    finally {state.busy=false;toolbar();}
  }
  async function saveLocal() {
    if (!state.doc?.dirty) return;
    state.drafts[state.doc.id]={...state.doc,updatedAt:new Date().toISOString()};
    await vault.write({drafts:state.drafts});
    const status=$('#draft-status');if(status)status.textContent='이 브라우저에 초안 저장됨';
  }
  async function flushLocal() {clearTimeout(draftTimer);await saveLocal();await vault.flush();}
  async function refresh() {
    if (state.client) {state.snapshot=await state.client.snapshot();state.cache.clear();}
    const response=await fetch(`/superhome/content.json?v=${Date.now()}`,{cache:'no-store',credentials:'omit'});
    if (!response.ok) throw Error('게시글 현황을 불러오지 못했습니다. 잠시 후 새로고침해주세요.');
    state.manifest=await response.json();
  }
  async function file(path) {
    if (!state.client) throw Error('GitHub를 연결하면 기존 내용을 수정하고 저장할 수 있습니다.');
    if(!state.snapshot)state.snapshot=await state.client.snapshot();
    if(!state.cache.has(path))state.cache.set(path,await state.client.read(path,state.snapshot));
    return state.cache.get(path);
  }
  function posts() {
    const published=new Map(state.manifest.posts.map(post=>[post.path,post]));for(const [path,post] of state.postOverrides)post?published.set(path,post):published.delete(path);
    const entries=state.snapshot?[...state.snapshot.files.keys()].filter(path=>POST_PATTERN.test(path)): [...published.keys()];
    return entries.map(path=>published.get(path)||{path,title:path.split('/').pop().replace(/\.(md|markdown|html)$/i,''),date:path.split('/').pop().slice(0,10),unlisted:true,tags:[]}).sort((a,b)=>b.date.localeCompare(a.date)||a.title.localeCompare(b.title));
  }
  function listPosts(limit=Infinity) {
    const query=state.view==='posts'?state.postQuery.trim().toLowerCase():'';
    const entries=posts().filter(post=>`${post.title} ${post.tags?.join(' ')} ${post.path}`.toLowerCase().includes(query)).slice(0,limit);
    return entries.length?entries.map(post=>`<article class="admin-post-row"><div><span class="admin-date">${esc(post.date)}${post.unlisted?' · 사이트에 미노출':''}</span><h3>${esc(post.title)}</h3><p>${esc(post.tags?.join(' · '))}</p></div>${button('수정','edit-post',`data-path="${esc(post.path)}" data-needs-github`)}${post.url?`<a class="admin-text-link" href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">사이트에서 보기 ↗</a>`:''}</article>`).join(''):'<p class="admin-empty">검색 결과가 없습니다.</p>';
  }
  function connectionNote() {return state.client?'':`<div class="admin-note">기존 콘텐츠 수정과 사이트 발행에는 GitHub 연결이 필요합니다. ${button('GitHub 연결','connect')}</div>`;}
  function render() {
    $('#workspace-title').textContent=state.doc?state.doc.kind==='post'?'글 편집':labels[state.doc.kind]:labels[state.view] || '관리';
    const screen=$('#admin-screen');
    if(state.doc) {screen.innerHTML=editor();updatePreview();toolbar();return;}
    if(state.view==='overview') {
      screen.innerHTML=`${connectionNote()}<div class="admin-metrics"><article><span>사이트에 공개된 글</span><strong>${state.manifest.posts.length}</strong></article><article><span>포트폴리오 성과</span><strong>${state.manifest.projects.length}</strong></article><article><span>이 브라우저의 초안</span><strong>${Object.keys(state.drafts).length}</strong></article><article><span>최근 발행</span><strong class="date-metric">${esc(state.manifest.posts[0]?.date || '—')}</strong></article></div><section class="admin-panel"><div class="panel-heading"><h2>최근 기록</h2>${button('새로고침','refresh')}</div>${listPosts(5)}</section><section class="admin-panel"><h2>방문 통계</h2><p>블로그 방문 통계는 수집 서비스를 연결한 뒤 확인할 수 있습니다. GitHub 저장소 트래픽은 블로그 방문 수와 다릅니다.</p><div class="inline-actions">${button('방문 통계 연결','view','data-view="analytics"')}${button('저장소 트래픽 조회','traffic','data-needs-github')}</div><div id="traffic-result"></div></section>`;
    } else if(state.view==='posts') {
      screen.innerHTML=`${connectionNote()}<div class="admin-list-tools"><label class="admin-field"><span>글 검색</span><input id="admin-post-search" type="search" value="${esc(state.postQuery)}" placeholder="제목, 태그, 파일명"></label>${button('목록 새로고침','refresh')}</div><section class="admin-panel" id="admin-post-list">${listPosts()}</section>`;
    } else if(state.view==='drafts') {
      const drafts=Object.values(state.drafts).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
      screen.innerHTML=`<div class="admin-note">초안은 이 브라우저에 암호화해 보관됩니다. 다른 기기와 자동 동기화되지 않으며, 브라우저 데이터를 지우기 전에 Markdown으로 내려받아주세요.</div><section class="admin-panel">${drafts.length?drafts.map(draft=>`<article class="admin-post-row"><div><span class="admin-date">${esc(labels[draft.kind] || '글')} · ${esc(new Date(draft.updatedAt).toLocaleString('ko-KR'))}</span><h3>${esc(draft.fields?.title || draft.path || '새 글')}</h3></div>${button('이어 쓰기','resume',`data-id="${esc(draft.id)}"`)}${button('초안 삭제','discard',`data-id="${esc(draft.id)}"`)}</article>`).join(''):'<p class="admin-empty">저장된 초안이 없습니다. 새 글을 작성해보세요.</p>'}</section>`;
    }
    if(fileKinds[state.view])screen.innerHTML=connectionNote()+'<section class="admin-panel"><h2>GitHub 연결 후 편집할 수 있습니다.</h2><p>연결한 저장소의 최신 내용을 불러와 안전하게 수정합니다.</p></section>';
    toolbar();
  }
  function editor() {
    const document=state.doc;
    let fields='';
    if(document.kind==='post'||document.kind==='about') {
      fields=`<div class="editor-fields">${field('제목','fields.title',document.fields.title,{wide:true})}${field('부제목','fields.subtitle',document.fields.subtitle,{wide:true})}${document.kind==='post'?field('날짜','fields.date',document.fields.date,{type:'date',readonly:Boolean(document.path)})+field('주소','fields.slug',document.fields.slug,{readonly:Boolean(document.path),help:document.path?'기존 글의 URL은 유지합니다.':'영문 소문자·숫자·하이픈. 발행 전 확인해주세요.'})+field('태그','fields.tags',document.fields.tags,{wide:true,help:'쉼표로 구분합니다.'}):''}</div><div class="markdown-editor"><label class="admin-field"><span>Markdown 본문</span><textarea id="markdown-body" data-field="fields.body" class="code-input" rows="24">${esc(document.fields.body)}</textarea></label><section class="preview-panel"><h3>미리보기</h3><iframe id="markdown-preview" title="Markdown 미리보기" sandbox="" referrerpolicy="no-referrer"></iframe></section></div>${document.kind==='post'?`<div class="inline-actions">${button('이미지 업로드','upload','data-needs-github')}<span class="admin-help">선택한 이미지는 저장소에 업로드됩니다. PNG·JPG·WebP·GIF, 최대 8MB.</span><input id="image-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div>`:''}`;
    } else if(document.kind==='projects') {
      fields=`<div class="editor-items">${document.items.map((item,index)=>`<section class="admin-panel"><div class="panel-heading"><h2>${esc(item.title || '새 성과')}</h2><div>${button('위로','move-item',`data-index="${index}" data-direction="-1"`)}${button('아래로','move-item',`data-index="${index}" data-direction="1"`)}${button('항목 삭제','remove-item',`data-index="${index}"`)}</div></div><div class="editor-fields">${field('식별자','items.'+index+'.id',item.id,{help:'링크 유지에 사용됩니다. 기존 식별자는 바꾸지 마세요.',readonly:document.originalIds.includes(item.id)})}${field('제목','items.'+index+'.title',item.title)}${field('대표 수치','items.'+index+'.result',item.result)}${field('수치 설명','items.'+index+'.result_label',item.result_label)}${field('설명','items.'+index+'.description',item.description,{area:true,wide:true})}${field('결과 요약','items.'+index+'.outcome',item.outcome)}${field('관련 글 주소','items.'+index+'.article_url',item.article_url || '',{help:'사이트 안의 /날짜-주소/ 형식. 없으면 비워두세요.'})}</div></section>`).join('')}</div>${button('성과 추가','add-item')}`;
    } else if(document.kind==='career') {
      fields=`${document.items.map((item,index)=>`<section class="admin-panel"><div class="panel-heading"><h2>${esc(item.company || '새 경력')}</h2><div>${button('위로','move-item',`data-index="${index}" data-direction="-1"`)}${button('항목 삭제','remove-item',`data-index="${index}"`)}</div></div><div class="editor-fields">${field('회사','items.'+index+'.company',item.company)}${field('역할','items.'+index+'.role',item.role)}${field('시작','items.'+index+'.start',item.start)}${field('종료','items.'+index+'.end',item.end)}${field('담당한 일','items.'+index+'.description',item.description,{area:true,wide:true})}${field('기술','items.'+index+'.skills',item.skills,{wide:true,help:'쉼표로 구분합니다.'})}</div></section>`).join('')}${button('경력 추가','add-item')}`;
    } else if(document.kind==='skills') {
      fields=`${document.items.map((item,index)=>`<section class="admin-panel"><div class="panel-heading"><h2>${esc(item.title || '기술 그룹')}</h2>${button('항목 삭제','remove-item',`data-index="${index}"`)}</div>${field('그룹 이름','items.'+index+'.title',item.title)}${field('기술 목록','items.'+index+'.content',item.content,{area:true,rows:3,help:'가운데 점(·)으로 구분해 표시합니다.'})}</section>`).join('')}${button('기술 그룹 추가','add-item')}`;
    } else if(document.kind==='home'||document.kind==='work') {
      fields=`<div class="admin-panel editor-fields">${document.definitions.map(definition=>field(definition.label,'fields.'+definition.key,document.fields[definition.key],{area:true,rows:definition.rows || 3,wide:true})).join('')}</div>`;
    } else if(document.kind==='analytics') {
      fields=`<section class="admin-panel"><h2>Cloudflare Web Analytics</h2><p>현재 사이트의 방문 데이터를 수집하려면 Cloudflare에서 이 사이트를 등록한 뒤 발급받은 공개 Beacon token을 입력하세요. 과거 데이터는 소급해서 생기지 않습니다.</p><p><a href="https://dash.cloudflare.com/?to=/:account/web-analytics" target="_blank" rel="noopener noreferrer">Cloudflare 방문 통계 열기 ↗</a></p>${field('공개 Beacon token','fields.beacon',document.fields.beacon,{help:'API 비밀 키가 아닌 웹사이트 삽입용 공개 토큰입니다. 비우고 저장하면 수집을 끕니다.'})}<p class="admin-help">수집 활성화는 사이트에 방문 분석 스크립트를 추가합니다. 이 화면에서 Cloudflare API 비밀 키를 요청하거나 저장하지 않습니다.</p></section>`;
    }
    return `<div class="editor-toolbar"><div>${button('목록으로','back')}<span id="draft-status">${document.dirty?'변경 내용 있음':'편집 중'}</span></div><div>${button('초안 저장','save-draft')}${['post','about'].includes(document.kind)?button('Markdown 내려받기','download'):''}${button(document.kind==='post'?'사이트에 발행':'사이트에 저장','publish','class="admin-primary" data-needs-github')}</div></div>${connectionNote()}${fields}${document.kind==='post'&&document.path?`<div class="danger-zone"><p>발행 중지는 사이트에서만 숨깁니다. 공개 GitHub 저장소의 원문은 남습니다.</p>${button('사이트에서 발행 중지','unpublish','data-needs-github')}${button('원격 글 삭제','delete-post','class="admin-danger" data-needs-github')}</div>`:''}`;
  }
  function updatePreview() {
    const frame=$('#markdown-preview');if(!frame||!state.doc?.fields) return;
    const html=DOMPurify.sanitize(markdown.render(state.doc.fields.body || ''),{FORBID_TAGS:['script','style','iframe','form','input','button','object','embed','link','meta'],FORBID_ATTR:['style']});
    frame.srcdoc=`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><style>body{margin:24px;font:16px/1.85 system-ui,sans-serif;color:#252c30;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4}img{max-width:100%}pre{overflow:auto;padding:16px;background:#f0f4f6;border-radius:6px}code{font-size:.85em;background:#f0f4f6}blockquote{margin-inline:0;padding:12px 20px;background:#faf6e6;border-left:3px solid #dcc567}table{display:block;overflow:auto;border-collapse:collapse}td,th{padding:8px;border:1px solid #b6c7d0}</style></head><body>${html}</body></html>`;
  }
  const htmlDefinitions={
    home:[{key:'role',label:'직무 소개',selector:'.hero-copy .eyebrow',pattern:/(<div class="hero-copy">\s*<p class="eyebrow">)[\s\S]*?(<\/p>)/},{key:'motto',label:'모토',selector:'.hero-motto',pattern:/(<p class="hero-motto">)[\s\S]*?(<\/p>)/},{key:'description',label:'홈 소개',selector:'.hero-description',pattern:/(<p class="hero-description">)[\s\S]*?(<\/p>)/},{key:'nowHeading',label:'요즘 하는 일 제목',selector:'#now-title',pattern:/(<h2 id="now-title">)[\s\S]*?(<\/h2>)/},{key:'nowBody',label:'요즘 하는 일 설명',selector:'.now-panel > p:not(.eyebrow)',pattern:/(<h2 id="now-title">[\s\S]*?<\/h2><p>)[\s\S]*?(<\/p>)/},{key:'scale',label:'서비스 규모·업무 범위',selector:'.now-scale',pattern:/(<p class="now-scale">)[\s\S]*?(<\/p>)/},{key:'personalTitle',label:'개인 소개 제목',selector:'.personal-note h2',pattern:/(<aside class="personal-note">[\s\S]*?<h2>)[\s\S]*?(<\/h2>)/},{key:'personalBody',label:'개인 소개 설명',selector:'.personal-note p:not(.eyebrow)',pattern:/(<aside class="personal-note">[\s\S]*?<\/h2><p>)[\s\S]*?(<\/p>)/}],
    work:[{key:'heading',label:'포트폴리오 제목',selector:'.work-hero-copy h1',pattern:/(<h1>)[\s\S]*?(<\/h1>)/},{key:'lead',label:'포트폴리오 소개',selector:'.work-hero-copy .page-lead',pattern:/(<p class="page-lead">)[\s\S]*?(<\/p>)/},{key:'scopeTitle',label:'업무 범위 제목',selector:'#scope-title',pattern:/(<h2 id="scope-title">)[\s\S]*?(<\/h2>)/},{key:'scope',label:'업무 범위 설명',selector:'.work-scope > p',pattern:/(<h2 id="scope-title">[\s\S]*?<\/h2><p>)[\s\S]*?(<\/p>)/},{key:'proof',label:'업무 요약 문구',selector:'.work-proof > strong',pattern:/(<div class="work-proof">[\s\S]*?<strong>)[\s\S]*?(<\/strong>)/}]
  };
  async function openDocument(kind,path) {
    await flushLocal();
    const source=await file(path || fileKinds[kind]);
    const document={id:crypto.randomUUID(),kind,path:source.path,sha:source.sha,original:source.raw,dirty:false};
    if(kind==='post')document.fields=parsePost(source.raw,source.path);
    else if(kind==='about') {const part=splitDocument(source.raw);if(part.document.errors.length)throw Error('소개 파일 머리말을 읽을 수 없습니다.');const data=part.document.toJS();document.fields={title:data.title || '',subtitle:data.subtitle || '',body:part.body};}
    else if(kind==='projects') {document.items=YAML.parse(source.raw);if(!Array.isArray(document.items))throw Error('성과 목록 형식을 확인해주세요.');document.originalItemsCount=document.items.length;document.originalIds=document.items.map(item=>item.id);document.relatedWork=await file('work.html');}
    else if(kind==='career')document.items=[...dom(source.raw).querySelectorAll('.exp-row')].map(row=>{const dates=multiline(row.querySelector('.exp-year')).split('\n');return {start:dates[0]?.trim() || '',end:dates.slice(1).join(' ').replace(/^\s*—\s*/,''),company:text(row.querySelector('.exp-company')),role:text(row.querySelector('.exp-role')),description:text(row.querySelector('.exp-desc')),skills:[...row.querySelectorAll('.pill')].map(text).join(', ')};});
    else if(kind==='skills')document.items=[...dom(source.raw).querySelectorAll('.skill-group')].map(row=>({title:text(row.querySelector('h3')),content:text(row.querySelector('p'))}));
    else if(kind==='home'||kind==='work') {const parsed=dom(source.raw);document.definitions=htmlDefinitions[kind].map(({key,label,rows})=>({key,label,rows}));document.fields=Object.fromEntries(htmlDefinitions[kind].map(definition=>[definition.key,multiline(parsed.querySelector(definition.selector))]));}
    else if(kind==='analytics') {const parsed=YAML.parse(source.raw);document.fields={beacon:parsed.cloudflare_analytics || ''};}
    state.doc=document;state.view=kind;render();
  }
  async function compile(document,published=true) {
    let raw,path=document.path;
    if(document.kind==='post') {path=path || newPostPath(document.fields);raw=postSource(document.original,document.fields,published);}
    else if(document.kind==='about') {const {document:header}=splitDocument(document.original);if(!document.fields.title.trim())throw Error('소개 제목을 입력해주세요.');header.set('title',document.fields.title.trim());header.set('subtitle',document.fields.subtitle.trim());raw=`---\n${String(header).trimEnd()}\n---\n\n${document.fields.body.trim()}\n`;}
    else if(document.kind==='projects') {
      const ids=new Set();for(const item of document.items){if(!/^[a-z0-9-]+$/.test(item.id)||ids.has(item.id)||!String(item.title).trim())throw Error('성과 식별자는 중복 없는 영문·숫자·하이픈이어야 하며 제목이 필요합니다.');ids.add(item.id);if(item.article_url&&!/^\/(?!\/)[^\s<>"']*$/.test(item.article_url))throw Error('관련 글은 사이트 내부 주소로 입력해주세요.');}
      raw=YAML.stringify(document.items.map(item=>({...item,article_url:item.article_url || null})));
    } else if(document.kind==='career') {if(document.items.some(item=>!item.company.trim()))throw Error('회사 이름을 입력해주세요.');raw=document.items.map(item=>`<div class="exp-row"><div class="exp-left"><div class="exp-year">${esc(item.start)}<br>— ${esc(item.end)}</div></div><div class="exp-divider" aria-hidden="true"></div><div><div class="exp-company">${esc(item.company)}</div><div class="exp-role">${esc(item.role)}</div><div class="exp-desc">${esc(item.description)}</div><div class="exp-pills">${item.skills.split(',').map(value=>value.trim()).filter(Boolean).map(value=>`<span class="pill">${esc(value)}</span>`).join('')}</div></div></div>`).join('\n')+'\n';}
    else if(document.kind==='skills')raw=document.items.map(item=>`<div class="skill-group"><h3>${esc(item.title)}</h3><p>${esc(item.content)}</p></div>`).join('\n')+'\n';
    else if(document.kind==='home'||document.kind==='work') {raw=document.original;const originalDOM=dom(raw);for(const definition of htmlDefinitions[document.kind]){if(document.fields[definition.key]!==multiline(originalDOM.querySelector(definition.selector))){if(!definition.pattern.test(raw))throw Error('페이지 구조가 바뀌어 문구를 안전하게 수정할 수 없습니다.');raw=raw.replace(definition.pattern,(_,before,after)=>before+lines(document.fields[definition.key])+after);}}}
    else if(document.kind==='analytics') {const token=document.fields.beacon.trim();if(token&&!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(token))throw Error('Cloudflare의 공개 Beacon token 형식을 확인해주세요.');const parsed=YAML.parseDocument(document.original);token?parsed.set('cloudflare_analytics',token):parsed.delete('cloudflare_analytics');raw=String(parsed);}
    const changes=[{path,sha:document.sha,raw}];
    if(document.kind==='projects'&&document.relatedWork){let work=document.relatedWork.raw;let index=0;work=work.replace(/(<span>)([^<]*)(<b>[^<]*<\/b><\/span>)/g,(match,before,value,after)=>{index++;const project=index===2?document.items.find(item=>item.id==='analytics'):index===3?document.items.find(item=>item.id==='security'):null;return project?before+esc(project.result)+after:match;});if(work!==document.relatedWork.raw)changes.push({path:'work.html',sha:document.relatedWork.sha,raw:work});}
    return changes;
  }
  async function publish(published=true) {
    if(!state.client)throw Error('먼저 GitHub를 연결해주세요.');
    await flushLocal();
    const changes=await compile(state.doc,published);
    const commit=await state.client.commit(changes,`superhome: ${published?'save':'unpublish'} ${state.doc.kind==='post'?state.doc.fields.title:labels[state.doc.kind]}`);
    if(state.doc.kind==='post'){const path=changes[0].path;state.postOverrides.set(path,{path,title:state.doc.fields.title,date:state.doc.fields.date,tags:state.doc.fields.tags.split(',').map(value=>value.trim()).filter(Boolean),unlisted:!published,url:published?'/'+path.split('/').pop().replace(/\.(md|markdown|html)$/i,'')+'/':null});}
    delete state.drafts[state.doc.id];await vault.write({drafts:state.drafts});
    state.doc=null;state.view='posts';state.lastCommit=commit.sha;
    await refresh();render();notice(`GitHub에 저장했습니다 (${commit.sha.slice(0,7)}). 사이트는 빌드 후 반영됩니다. 배포 결과는 GitHub Actions에서 확인할 수 있습니다.`);
  }
  function confirmation(title,description,requiredValue='') {
    const dialog=$('#confirm-dialog');$('#confirm-title').textContent=title;$('#confirm-description').textContent=description;$('#confirm-value').value='';$('#confirm-label').hidden=!requiredValue;
    dialog.returnValue='cancel';dialog.querySelectorAll('button,input').forEach(element=>{element.disabled=false;});dialog.showModal();
    return new Promise(resolve=>{const cleanup=()=>{dialog.removeEventListener('close',close);$('#confirm-form').removeEventListener('submit',submit);$('#confirm-cancel').removeEventListener('click',cancel);};const close=()=>{cleanup();resolve(dialog.returnValue==='confirm');};const cancel=()=>dialog.close('cancel');const submit=event=>{event.preventDefault();if(requiredValue&&$('#confirm-value').value!==requiredValue){$('#confirm-value').setCustomValidity('제목을 정확히 입력해주세요.');$('#confirm-value').reportValidity();return;}dialog.close('confirm');};$('#confirm-value').oninput=()=>$('#confirm-value').setCustomValidity('');$('#confirm-form').addEventListener('submit',submit);$('#confirm-cancel').addEventListener('click',cancel);dialog.addEventListener('close',close);});
  }
  async function traffic() {
    if(!state.client)throw Error('GitHub를 연결해주세요.');
    const target=$('#traffic-result');
    try {const data=await state.client.request(`/repos/${REPOSITORY}/traffic/views`);target.innerHTML=`<h3>GitHub 저장소 방문 · 최근 14일</h3><p>조회 ${Number(data.count).toLocaleString()}회 · 순 방문자 ${Number(data.uniques).toLocaleString()}명</p><p class="admin-help">이 수치는 블로그 방문자가 아닙니다.</p><div class="admin-table-scroll"><table><thead><tr><th>날짜</th><th>조회</th><th>순 방문자</th></tr></thead><tbody>${data.views.map(day=>`<tr><td>${esc(day.timestamp.slice(0,10))}</td><td>${Number(day.count)}</td><td>${Number(day.uniques)}</td></tr>`).join('')}</tbody></table></div>`;}
    catch(error) {target.textContent='저장소 트래픽을 읽지 못했습니다. 필요한 경우 Administration → Read 권한을 추가해주세요. 블로그 방문 통계는 별도 연결이 필요합니다.';}
  }
  async function upload(fileObject) {
    if(!fileObject)return;if(!state.client)throw Error('이미지 업로드에는 GitHub 연결이 필요합니다.');
    const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
    const extension=extensions[fileObject.type];if(!extension||fileObject.size>8*1024*1024)throw Error('8MB 이하의 PNG·JPG·WebP·GIF 이미지를 선택해주세요.');
    const signature=new Uint8Array(await fileObject.slice(0,12).arrayBuffer());const ascii=new TextDecoder().decode(signature);const valid=extension==='png'?signature.slice(0,8).join(',')==='137,80,78,71,13,10,26,10':extension==='jpg'?signature[0]===255&&signature[1]===216&&signature[2]===255:extension==='gif'?/^GIF8[79]a/.test(ascii):ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP';if(!valid)throw Error('이미지 파일의 실제 형식이 올바르지 않습니다.');
    const path=`assets/img/uploads/${today()}-${crypto.randomUUID()}.${extension}`;
    await state.client.commit([{path,sha:null,base64:encode64(new Uint8Array(await fileObject.arrayBuffer()))}],`superhome: upload ${path.split('/').pop()}`);
    const body=$('#markdown-body');const start=body.selectionStart;const insertion=`\n![${fileObject.name.replace(/[\[\]\r\n]/g,'')}](/${path})\n`;
    state.doc.fields.body=body.value.slice(0,start)+insertion+body.value.slice(body.selectionEnd);state.doc.dirty=true;await saveLocal();render();notice('이미지를 업로드하고 본문에 주소를 넣었습니다. 글은 아직 발행되지 않았습니다.');
  }
  root.addEventListener('click',event=>{
    lastActivity=Date.now();const element=event.target.closest('[data-action]');if(!element)return;
    const action=element.dataset.action;
    if(action==='close-dialog'){$('#'+element.dataset.dialog).close();return;}
    if(action==='connect'){$('#connect-error').hidden=true;$('#github-token').value='';$('#github-dialog').showModal();return;}
    if(action==='upload'){$('#image-upload').click();return;}
    if(action==='lock'){task(async()=>{await flushLocal();state.client?.disconnect();lock();});return;}
    task(async()=>{
      if(action==='view'||action==='back'){await flushLocal();state.doc=null;state.view=action==='back'?'posts':element.dataset.view;notice('');if(fileKinds[state.view]&&state.client)await openDocument(state.view);else render();}
      else if(action==='new-post'){await flushLocal();state.doc={id:crypto.randomUUID(),kind:'post',path:'',sha:null,original:'',fields:{title:'',subtitle:'',tags:'',body:'',date:today(),slug:'note-'+crypto.randomUUID().slice(0,8)},dirty:true};render();}
      else if(action==='edit-post')await openDocument('post',element.dataset.path);
      else if(action==='refresh'){await refresh();render();notice('목록을 새로 불러왔습니다.');}
      else if(action==='save-draft'){await saveLocal();notice('이 브라우저에 초안을 저장했습니다. 아직 사이트에 발행하지 않았습니다.');}
      else if(action==='resume'){await flushLocal();state.doc=structuredClone(state.drafts[element.dataset.id]);if(!state.doc)throw Error('초안을 찾을 수 없습니다.');render();}
      else if(action==='discard'){if(await confirmation('이 초안을 삭제할까요?','이 브라우저에 저장된 초안만 삭제합니다. 원격 글은 바뀌지 않습니다.')){delete state.drafts[element.dataset.id];await vault.write({drafts:state.drafts});render();}}
      else if(action==='publish')await publish(true);
      else if(action==='unpublish'){if(await confirmation('사이트에서 발행을 중지할까요?','글 원문은 GitHub 저장소에 유지됩니다.'))await publish(false);}
      else if(action==='delete-post'){if(await confirmation('원격 글을 삭제할까요?','저장소와 사이트에서 이 글을 삭제합니다. Git 기록에서는 복구할 수 있습니다.',state.doc.fields.title)){await flushLocal();const commit=await state.client.commit([{path:state.doc.path,sha:state.doc.sha,remove:true}],`superhome: delete ${state.doc.fields.title}`);delete state.drafts[state.doc.id];await vault.write({drafts:state.drafts});state.doc=null;state.view='posts';await refresh();render();notice(`글을 삭제했습니다 (${commit.sha.slice(0,7)}).`);}}
      else if(action==='download'){const raw=state.doc.kind==='post'?postSource(state.doc.original,{...state.doc.fields,title:state.doc.fields.title || '제목 없는 초안',body:state.doc.fields.body || '\n'},false):(await compile(state.doc))[0].raw;const url=URL.createObjectURL(new Blob([raw],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=state.doc.path.split('/').pop() || `${state.doc.fields.date}-${state.doc.fields.slug}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      else if(action==='add-item'){const item=state.doc.kind==='projects'?{id:'project-'+crypto.randomUUID().slice(0,8),title:'',result:'',result_label:'',description:'',outcome:'',article_url:''}:state.doc.kind==='career'?{company:'',role:'',start:'',end:'현재',description:'',skills:''}:{title:'',content:''};state.doc.items.push(item);state.doc.dirty=true;await saveLocal();render();}
      else if(action==='remove-item'){state.doc.items.splice(Number(element.dataset.index),1);state.doc.dirty=true;await saveLocal();render();}
      else if(action==='move-item'){const index=Number(element.dataset.index),next=index+Number(element.dataset.direction);if(next>=0&&next<state.doc.items.length){[state.doc.items[index],state.doc.items[next]]=[state.doc.items[next],state.doc.items[index]];state.doc.dirty=true;await saveLocal();render();}}
      else if(action==='traffic')await traffic();
    });
  });
  root.addEventListener('input',event=>{
    lastActivity=Date.now();
    if(event.target.id==='admin-post-search'){state.postQuery=event.target.value;$('#admin-post-list').innerHTML=listPosts();toolbar();return;}
    const name=event.target.dataset.field;if(!name||!state.doc)return;
    const keys=name.split('.');if(keys.some(key=>['__proto__','prototype','constructor'].includes(key)))return;
    let object=state.doc;for(const key of keys.slice(0,-1))object=object[key];object[keys.at(-1)]=event.target.value;state.doc.dirty=true;
    $('#draft-status').textContent='변경 내용 저장 중…';clearTimeout(draftTimer);draftTimer=setTimeout(()=>saveLocal().catch(error=>notice(`초안을 보관하지 못했습니다: ${error.message}`,true)),600);
    if(name==='fields.body'){clearTimeout(previewTimer);previewTimer=setTimeout(updatePreview,200);}
  });
  root.addEventListener('change',event=>{if(event.target.id==='image-upload')task(()=>upload(event.target.files[0]));});
  root.addEventListener('submit',event=>{
    if(event.target.id!=='github-form')return;event.preventDefault();
    const token=$('#github-token').value.trim();$('#github-token').value='';
    task(async()=>{const client=new GitHubClient(token);try{const user=await client.connect();const snapshot=await client.snapshot();state.client?.disconnect();state.client=client;state.user={login:user.login};state.snapshot=snapshot;state.cache.clear();$('#github-dialog').close();if(!state.doc){if(fileKinds[state.view])await openDocument(state.view);else render();}notice('GitHub에 연결했습니다. 토큰은 이 탭을 닫거나 로그아웃하면 지워집니다.');}catch(error){client.disconnect();$('#connect-error').textContent=error.message;$('#connect-error').hidden=false;}});
  });
  window.addEventListener('beforeunload',event=>{if(state.doc?.dirty && $('#draft-status')?.textContent==='변경 내용 저장 중…'){event.preventDefault();event.returnValue='';}});
  const touch=()=>{lastActivity=Date.now();};window.addEventListener('pointerdown',touch);window.addEventListener('keydown',touch);
  setInterval(()=>{if(Date.now()-lastActivity>30*60*1000)flushLocal().finally(()=>{state.client?.disconnect();lock();});},60000);
  await task(async()=>{await refresh();render();notice('관리 화면을 열었습니다. 실제 저장·발행은 GitHub 권한으로 보호됩니다.');});
}

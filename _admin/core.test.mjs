import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {allowedPath,parsePost,postSource,newPostPath,GitHubClient} from './core.mjs';

test('editing preserves unknown front matter, comments, URL metadata and body',()=>{
  const original='---\nlayout: post\n# retain this\ntitle: Old\npermalink: /keep-me/\ncustom: [one, two]\ntags: [Java]\n---\n\nBody with {% raw %}{{ ID }}{% endraw %}.\n';
  const fields=parsePost(original,'_posts/2026-01-01-note.md');
  fields.title='A title: "quoted"\n---\nlayout: unexpected';fields.tags='Java, Spring, Java';
  const output=postSource(original,fields,true);
  const header=YAML.parse(output.split('\n---\n')[0].slice(4));
  assert.equal(header.title,fields.title);assert.equal(header.layout,'post');assert.equal(header.permalink,'/keep-me/');assert.deepEqual(header.custom,['one','two']);assert.deepEqual(header.tags,['Java','Spring']);assert(output.includes('# retain this'));assert(output.endsWith('Body with {% raw %}{{ ID }}{% endraw %}.\n'));
});
test('only managed paths are accepted',()=>{
  for(const path of ['_posts/2026-01-01-note.md','_posts/TILs/2020-01-01-한국어.md','assets/img/uploads/a-b.png','index.html','_data/projects.yml'])assert(allowedPath(path),path);
  for(const path of ['../_config.yml','_posts/../_config.yml','_posts//2026-01-01-x.md','_admin/workspace.mjs','.github/workflows/ci.yml','assets/img/uploads/a.svg','https://example.com/file'])assert(!allowedPath(path),path);
});
test('new post URLs reject invalid dates, future dates and traversal',()=>{
  assert.equal(newPostPath({date:'2026-01-01',slug:'hello-world'}),'_posts/2026-01-01-hello-world.md');
  assert.throws(()=>newPostPath({date:'2026-02-30',slug:'note'}));assert.throws(()=>newPostPath({date:'2999-01-01',slug:'note'}));assert.throws(()=>newPostPath({date:'2026-01-01',slug:'../../config'}));
});
function mockClient({conflict=false,rejectRef=false}={}) {
  const calls=[];
  const fetcher=async(url,options)=>{
    assert(url.startsWith('https://api.github.com/repos/dpdtydz/dpdtydz.github.io/'));
    assert.equal(options.headers.Authorization,'Bearer test-only-token');
    const body=options.body?JSON.parse(options.body):null;calls.push({url,method:options.method,body});
    let data,status=200;
    if(url.includes('/git/ref/heads/'))data={object:{sha:'current-head'}};
    else if(url.endsWith('/git/commits/current-head'))data={tree:{sha:'base-tree'}};
    else if(url.includes('/git/trees/base-tree'))data={tree:[{path:'aboutme.md',type:'blob',sha:conflict?'changed-sha':'expected-sha'}]};
    else if(url.endsWith('/git/trees')&&options.method==='POST')data={sha:'new-tree'};
    else if(url.endsWith('/git/commits')&&options.method==='POST')data={sha:'new-commit'};
    else if(options.method==='PATCH'){status=rejectRef?422:200;data={};}
    else throw Error('Unexpected test request');
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  };
  return {client:new GitHubClient('test-only-token',fetcher),calls};
}
test('multiple files are saved in one non-forced commit',async()=>{
  const {client,calls}=mockClient();
  const commit=await client.commit([{path:'aboutme.md',sha:'expected-sha',raw:'new about'},{path:'_data/projects.yml',sha:null,raw:'[]'}],'test change');
  assert.equal(commit.sha,'new-commit');
  const tree=calls.find(call=>call.method==='POST'&&call.url.endsWith('/git/trees'));
  assert.equal(tree.body.tree.length,2);assert.equal(tree.body.base_tree,'base-tree');
  assert.deepEqual(calls.find(call=>call.method==='POST'&&call.url.endsWith('/git/commits')).body.parents,['current-head']);
  assert.deepEqual(calls.at(-1).body,{sha:'new-commit',force:false});
});
test('changed remote files are never overwritten',async()=>{
  const {client,calls}=mockClient({conflict:true});
  await assert.rejects(client.commit([{path:'aboutme.md',sha:'expected-sha',raw:'new about'}],'test'),/변경/);
  assert(calls.every(call=>call.method==='GET'));
});
test('concurrent ref failures are reported without retry or force',async()=>{
  const {client,calls}=mockClient({rejectRef:true});
  await assert.rejects(client.commit([{path:'aboutme.md',sha:'expected-sha',raw:'new about'}],'test'),/충돌/);
  assert.equal(calls.filter(call=>call.method==='PATCH').length,1);assert.equal(calls.at(-1).body.force,false);
});

test('encrypted bundle matches tracked editor sources',()=>{
 const fingerprint=crypto.createHash('sha256');
 for(const name of ['workspace.mjs','core.mjs','build.cjs','package-lock.json'])fingerprint.update(fs.readFileSync(new URL(name,import.meta.url),'utf8').replace(/\r\n/g,'\n'));
 const envelope=JSON.parse(fs.readFileSync(new URL('../assets/admin/workspace.enc.json',import.meta.url),'utf8'));
 assert.equal(envelope.sourceHash,fingerprint.digest('hex'));assert.equal(envelope.iterations,600000);assert.equal(envelope.algorithm,'AES-GCM');
});

test('default fetch retains the browser global receiver',async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=function(){if(this!==globalThis)throw new TypeError('Illegal invocation');return Promise.resolve(new Response(JSON.stringify({ok:true}),{status:200}));};
 try{const client=new GitHubClient('test-only-token');assert.deepEqual(await client.request('/user'),{ok:true});}finally{globalThis.fetch=previous;}
});

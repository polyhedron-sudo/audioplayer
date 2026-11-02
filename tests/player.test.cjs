// Run: node --test tests/player.test.cjs (no packages required).
// DOM/audio/network are simulated; live browser playback is checked separately.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/,'');
class Element{
  constructor(){this.children=[];this.attributes={};this.value='0';this.hidden=false;this.classList={toggle(){}}}
  append(...items){this.children.push(...items)}
  replaceChildren(...items){this.children=items}
  setAttribute(k,v){this.attributes[k]=v}
  removeAttribute(k){delete this.attributes[k];if(k==='src')this.src=''}
}
function fixture(fetcher){
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)};
  const audio=el('audio');Object.assign(audio,{paused:true,ended:false,currentTime:0,duration:NaN,volume:1,plays:0});
  audio.pause=()=>{audio.paused=true;audio.onpause?.()};
  audio.load=()=>{audio.paused=true;audio.ended=false;audio.currentTime=0;audio.duration=NaN;audio.onemptied?.()};
  audio.play=async()=>{audio.plays++;audio.paused=false;audio.ended=false;audio.onplay?.()};
  let objectId=0;const revoked=[];
  class BrowserURL extends URL{}
  BrowserURL.createObjectURL=()=> 'blob:cover-'+(++objectId);
  BrowserURL.revokeObjectURL=u=>revoked.push(u);
  const context={document:{getElementById:el,createElement:()=>new Element(),querySelector:()=>el('intro')},location:{href:'https://test.github.io/music/',pathname:'/music/',hostname:'test.github.io'},console,URL:BrowserURL,URLSearchParams,Blob,TextDecoder,AbortController,setTimeout,clearTimeout,fetch:fetcher||(async()=>new Response(new Uint8Array(10),{status:206}))};
  vm.createContext(context);vm.runInContext(script,context);
  const run=code=>vm.runInContext(code,context);
  const seed=()=>{run("tracks=[{file:'One.mp3',title:'One'},{file:'Two.mp3',title:'Two'},{file:'Three.mp3',title:'Three'}];select(0);rebuild()");};
  const flush=async()=>{await new Promise(setImmediate);await new Promise(setImmediate)};
  return{run,el,audio,context,revoked,seed,flush};
}
function syncsafe(n){return Buffer.from([(n>>>21)&127,(n>>>14)&127,(n>>>7)&127,n&127])}
function uint(n,count){const a=Buffer.alloc(count);a.writeUIntBE(n,0,count);return a}
const image=Buffer.from([255,216,255,217]);
function picture(version=3,type=3,utf16=false){return Buffer.concat([Buffer.from([utf16?1:0]),version===2?Buffer.from('JPG'):Buffer.from('image/jpeg\0'),Buffer.from([type]),utf16?Buffer.from([255,254,65,0,0,0]):Buffer.from([0]),image])}
function frame(version,id,body,flags=0){return Buffer.concat([Buffer.from(id),version===4?syncsafe(body.length):uint(body.length,version===2?3:4),version===2?Buffer.alloc(0):Buffer.from([0,flags]),body])}
function tag(version=3,body=picture(version),flags=0){const frames=frame(version,version===2?'PIC':'APIC',body);return Buffer.concat([Buffer.from([73,68,51,version,0,flags]),syncsafe(frames.length),frames])}
function rangeFetch(data,ignore=false,cancelled=[]){return async(url,options={})=>{
  if(options.signal?.aborted)throw new DOMException('aborted','AbortError');
  const match=options.headers.Range.match(/bytes=(\d+)-(\d+)/);
  const bytes=ignore?data:data.subarray(+match[1],+match[2]+1);
  return new Response(new ReadableStream({start(c){c.enqueue(bytes);if(!ignore)c.close()},cancel(){cancelled.push(true)}}),{status:ignore?200:206});
}}

test('filename URLs preserve spaces, apostrophes and # characters',()=>{
 const f=fixture();assert.equal(f.run("songURL(\"The '90s #1.mp3\")"),'https://test.github.io/music/used-songs/The%20%2790s%20%231.mp3'.replace('%27',"'"));
});
test('Next selects, stops playback and updates the Play label synchronously',async()=>{
 const f=fixture();f.seed();await f.run('play()');f.el('next').onclick();assert.equal(f.run('current'),1);assert.equal(f.audio.paused,true);assert.equal(f.el('play').attributes['aria-label'],'Play');await f.flush();
});
test('previous retains its existing play-on-click behavior',async()=>{const f=fixture();f.seed();f.el('previous').onclick();assert.equal(f.run('current'),2);assert.equal(f.audio.paused,false);await f.flush()});
test('pause and play do not change the artwork generation',async()=>{const f=fixture();f.seed();const generation=f.run('artworkRequest');await f.run('play()');f.el('play').onclick();assert.equal(f.run('artworkRequest'),generation);await f.flush()});
test('natural end advances to the next song and continues playback',async()=>{const f=fixture();f.seed();f.audio.ended=true;f.audio.onended();assert.equal(f.run('current'),1);assert.equal(f.audio.paused,false);await f.flush()});
test('repeat off ends the playlist with the correct control label',async()=>{const f=fixture();f.seed();f.run('select(2);rebuild()');f.audio.paused=true;f.audio.ended=true;f.audio.onended();assert.equal(f.run('current'),2);assert.equal(f.el('play').attributes['aria-label'],'Play');assert.equal(f.el('status').textContent,'End of playlist.');await f.flush()});
test('repeat one restarts the current track without reloading artwork',async()=>{const f=fixture();f.seed();f.run('repeat=2');const generation=f.run('artworkRequest');f.audio.currentTime=100;f.audio.onended();assert.equal(f.run('current'),0);assert.equal(f.audio.currentTime,0);assert.equal(f.run('artworkRequest'),generation);await f.flush()});
test('shuffle traverses every track before repeat-all; no immediate duplicate at boundary',async()=>{
 const f=fixture();f.seed();f.run('shuffled=true;repeat=1;rebuild()');const played=[f.run('current')];for(let i=0;i<2;i++){f.run('advance(1,true)');played.push(f.run('current'))}assert.equal(new Set(played).size,3);const last=f.run('current');f.run('advance(1,true)');assert.notEqual(f.run('current'),last);await f.flush();
});
test('repeat cycles through playlist, one, and off',()=>{const f=fixture();for(const label of ['Repeat: playlist','Repeat: one track','Repeat: off']){f.el('repeat').onclick();assert.equal(f.el('repeat').attributes['aria-label'],label)}});
test('seek and volume use valid values; invalid duration cannot seek',()=>{const f=fixture();f.audio.duration=100;f.el('seek').value='45';f.el('seek').oninput();assert.equal(f.audio.currentTime,45);f.audio.duration=0;f.el('seek').oninput();assert.equal(f.audio.currentTime,45);f.audio.onloadedmetadata();assert.equal(f.el('seek').disabled,true);f.el('volume').value='.3';f.el('volume').oninput();assert.equal(f.audio.volume,.3);f.audio.duration=184;f.audio.ondurationchange();assert.equal(f.el('duration').textContent,'3:04');f.audio.currentTime=185;f.audio.ontimeupdate();assert.equal(f.el('elapsed').textContent,'3:04')});
for(const version of [2,3,4])test('embedded cover parsing ID3v2.'+version,async()=>{const data=tag(version),f=fixture(rangeFetch(data));const b=await f.run("embeddedMp3Cover('song',new AbortController().signal)");assert.equal(b.type,'image/jpeg');assert.deepEqual(Buffer.from(await b.arrayBuffer()),image)});
test('UTF-16 image descriptions are skipped correctly',async()=>{const data=tag(3,picture(3,3,true)),f=fixture(rangeFetch(data));const b=await f.run("embeddedMp3Cover('song',new AbortController().signal)");assert.deepEqual(Buffer.from(await b.arrayBuffer()),image)});
test('front cover is preferred over other embedded pictures',async()=>{const body=Buffer.concat([frame(3,'APIC',picture(3,4)),frame(3,'APIC',Buffer.concat([picture(3,3).subarray(0,-4),Buffer.from([1,2,3])]))]);const data=Buffer.concat([Buffer.from([73,68,51,3,0,0]),syncsafe(body.length),body]);const f=fixture(rangeFetch(data));const b=await f.run("embeddedMp3Cover('song',new AbortController().signal)");assert.deepEqual(Buffer.from(await b.arrayBuffer()),Buffer.from([1,2,3]))});
test('tag-wide unsynchronisation is handled',async()=>{const raw=frame(3,'APIC',picture(3));const body=[];for(const byte of raw){body.push(byte);if(byte===255)body.push(0)}const data=Buffer.concat([Buffer.from([73,68,51,3,0,128]),syncsafe(body.length),Buffer.from(body)]);const f=fixture(rangeFetch(data));const b=await f.run("embeddedMp3Cover('song',new AbortController().signal)");assert.deepEqual(Buffer.from(await b.arrayBuffer()),image)});
test('hosts ignoring Range still provide embedded artwork; reader is cancelled',async()=>{const cancelled=[],data=Buffer.concat([tag(),Buffer.alloc(500)]),f=fixture(rangeFetch(data,true,cancelled));const b=await f.run("embeddedMp3Cover('song',new AbortController().signal)");assert(b);assert.equal(cancelled.length,1)});
test('missing, oversized, and malformed metadata return no artwork',async()=>{for(const data of [Buffer.alloc(10),Buffer.from([73,68,51,3,0,0,127,127,127,127]),tag().subarray(0,20)]){const f=fixture(rangeFetch(data));assert.equal(await f.run("embeddedMp3Cover('song',new AbortController().signal)"),null)}});
test('selecting another song aborts obsolete artwork work',async()=>{const signals=[];const f=fixture(async(u,o)=>{signals.push(o.signal);return new Response(new Uint8Array(10),{status:206})});f.seed();f.run('select(1)');assert.equal(signals[0].aborted,true);await f.flush()});
test('loaded object URLs are released; revisiting uses cached artwork',async()=>{
 let calls=0;const fetcher=rangeFetch(tag());const f=fixture(async(...a)=>{calls++;return fetcher(...a)});f.seed();await f.flush();assert.equal(calls,2);const src=f.el('cover').src;f.el('cover').onload();assert.equal(f.el('cover').hidden,false);f.run('select(1)');await f.flush();assert(f.revoked.includes(src));f.run('select(0)');await f.flush();assert.equal(calls,4);
});
test('artwork errors use a sidecar and never stop audio',async()=>{const f=fixture(async()=>{throw Error('network')});f.seed();f.run("tracks[1].artwork='Two.jpg';select(1)");await f.run('play()');await f.flush();assert(f.el('cover').src.endsWith('/Two.jpg'));assert.equal(f.audio.paused,false)});
test('track discovery ignores subfolders/images and preserves matching image metadata',async()=>{
 const f=fixture(async(url)=>url.includes('api.github.com')?new Response(JSON.stringify([{type:'file',name:'One.mp3'},{type:'file',name:'One.JPG'},{type:'dir',name:'Hidden.mp3'}])):new Response(new Uint8Array(10),{status:206}));await f.run('init()');assert.equal(f.run('tracks.length'),1);assert.equal(f.run('tracks[0].artwork'),'One.JPG');assert.equal(f.el('play').disabled,false);await f.flush();
});
test('API errors and empty lists disable controls with a useful message',async()=>{for(const response of [()=>new Response('',{status:403}),()=>new Response('[]')]){const f=fixture(async()=>response());await f.run('init()');assert.equal(f.el('play').disabled,true);assert.equal(f.run('tracks.length'),0);assert(f.el('status').textContent.length>0)}});
test('track text is rendered without interpreting markup',async()=>{const f=fixture();f.seed();f.run("tracks[0].title='<img onerror=bad()>Here';render()");assert.equal(f.el('tracks').children[0].children[0].children[1].children[0].textContent,'<img onerror=bad()>Here');await f.flush()});
test('placeholder disc is absent and cover fills the art frame',()=>{assert(!html.includes('id="fallbackArt"'));assert(html.includes('position:absolute;inset:0;width:100%;height:100%;object-fit:cover'));assert(!html.slice(0,html.indexOf('</style>')).includes('\\n'))});
test('artwork finishing after Play is still applied',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const f=fixture();f.context.pending=pending;f.run('embeddedMp3Cover=async()=>pending');f.seed();await f.run('play()');resolve(new Blob([image],{type:'image/jpeg'}));await f.flush();assert(f.el('cover').src.startsWith('blob:'));f.el('cover').onload();assert.equal(f.el('cover').hidden,false);
});
test('an obsolete artwork result cannot replace the current song cover',async()=>{
 const resolvers=[];const f=fixture();f.context.pending=()=>new Promise(r=>resolvers.push(r));f.run('embeddedMp3Cover=()=>pending()');f.seed();f.run('select(1)');resolvers[1](new Blob([image]));await f.flush();const src=f.el('cover').src;resolvers[0](new Blob([image]));await f.flush();assert.equal(f.el('cover').src,src);assert.equal(f.el('title').textContent,'Two');
});
test('embedded image decode failure revokes its URL and tries sidecar',async()=>{
 const f=fixture(rangeFetch(tag()));f.seed();f.run("tracks[0].artwork='One.jpg';select(0)");await f.flush();const url=f.el('cover').src;f.el('cover').onerror();assert(f.revoked.includes(url));assert(f.el('cover').src.endsWith('/One.jpg'));assert(f.el('cover').hidden);
});
test('a stale playback failure cannot overwrite the new song status',async()=>{
 const f=fixture();f.seed();let reject;f.audio.play=()=>new Promise((r,j)=>reject=j);const promise=f.run('play()');f.el('next').onclick();reject(Error('old track failed'));await promise;assert.equal(f.el('status').textContent,'');assert.equal(f.el('play').attributes['aria-label'],'Play');await f.flush();
});
test('ID3v2.4 frame unsynchronisation is handled',async()=>{
 const raw=picture(4),unsynced=[];for(const b of raw){unsynced.push(b);if(b===255)unsynced.push(0)}const body=frame(4,'APIC',Buffer.from(unsynced),2);const data=Buffer.concat([Buffer.from([73,68,51,4,0,0]),syncsafe(body.length),body]);const f=fixture(rangeFetch(data));const b=await f.run("embeddedMp3Cover('song',new AbortController().signal)");assert.deepEqual(Buffer.from(await b.arrayBuffer()),image);
});

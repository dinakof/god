/* Standalone shims: stand in for the Claude artifact runtime (db, downloads, sample, dictation) and add real audio recording. */
window.STANDALONE=true;
(function(){
  const CFG=window.CENTER_CONFIG||{};
  const configured=!!(CFG.SUPABASE_URL&&CFG.SUPABASE_ANON_KEY&&window.supabase);
  const sb=configured?window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_ANON_KEY,{auth:{persistSession:true,detectSessionInUrl:true}}):null;
  window.__sb=sb; window.__configured=configured;

  /* ---- login gate ---- */
  window.__gate=(async()=>{
    if(!sb)return;
    const {data:{session}}=await sb.auth.getSession();
    if(session){window.__user=session.user;return}
    await new Promise(res=>{
      const box=document.createElement('div');box.className='gate';
      box.innerHTML=`<div class="card" style="max-width:420px;margin:40px auto"><h2>כניסה לניהול המרכז</h2>
        <p class="small muted">נשלח אלייך קישור כניסה למייל. רק מי שהוגדרה כחברת צוות יכולה להיכנס.</p>
        <form id="gform" class="row" style="flex-direction:column;align-items:stretch"><label class="f" for="g-email">מייל<input id="g-email" type="email" required autocomplete="email" dir="ltr"></label>
        <button class="btn" type="submit">שליחת קישור כניסה</button><p id="g-msg" class="note" aria-live="polite"></p></form></div>`;
      document.getElementById('main').replaceChildren(box);
      box.querySelector('#gform').onsubmit=async e=>{e.preventDefault();const m=box.querySelector('#g-msg');m.textContent='שולחת…';
        const {error}=await sb.auth.signInWithOtp({email:box.querySelector('#g-email').value.trim(),options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}});
        m.textContent=error?'השליחה לא הצליחה: '+error.message:'נשלח! פתחי את המייל ולחצי על הקישור. אפשר לסגור את הדף הזה.'};
      sb.auth.onAuthStateChange((ev,s)=>{if(s){window.__user=s.user;res()}});
    });
  })();

  /* ---- db over one Supabase table: items(col,id,data) ---- */
  function makeDb(){
    const subs={};
    return {collection(col){return{
      onSnapshot(next,err){
        const load=async()=>{const {data,error}=await sb.from('items').select('id,data').eq('col',col).limit(5000);
          if(error){err&&err({code:'unavailable',message:error.message});return}
          next({docs:data.map(r=>({id:r.id,data:()=>r.data})),size:data.length,empty:!data.length})};
        load();
        let t=null;const ch=sb.channel('items-'+col).on('postgres_changes',{event:'*',schema:'public',table:'items',filter:'col=eq.'+col},()=>{clearTimeout(t);t=setTimeout(load,250)}).subscribe();
        document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
        return()=>sb.removeChannel(ch);
      },
      doc(id){return{
        async set(data){const {error}=await sb.from('items').upsert({col,id,data,updated_at:new Date().toISOString()});if(error)throw{code:/permission|policy/i.test(error.message)?'not_granted':'unavailable',message:error.message}},
        async delete(){const {error}=await sb.from('items').delete().eq('col',col).eq('id',id);if(error)throw{code:'unavailable',message:error.message}}
      }}
    }}};
  }

  /* ---- downloads ---- */
  const downloads={async save({filename,data}){const b=data instanceof Blob?data:new Blob([data],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}};

  /* ---- sample via Supabase Edge Function "ai" (holds the Anthropic key) ---- */
  async function ai(prompt){
    const {data,error}=await sb.functions.invoke('ai',{body:{prompt}});
    if(error||!data||data.error)throw{code:'unavailable',message:(error&&error.message)||(data&&data.error)||'ai failed'};
    return data.text||'';
  }
  const sample=Object.assign(async(input)=>({text:await ai(typeof input==='string'?input:input.map(m=>m.content).join('\n')),truncated:false}),{
    async json(input){const t=await ai((typeof input==='string'?input:input.map(m=>m.content).join('\n'))+'\n\nענה ב-JSON תקין בלבד, בלי טקסט נוסף.');const m=t.match(/[\[{][\s\S]*[\]}]/);if(!m)throw{code:'invalid_json',message:'no json',text:t};return JSON.parse(m[0])}
  });

  /* ---- recorder: MediaRecorder for the audio + Web Speech for live text ---- */
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  const rec={blob:null,mr:null,chunks:[],mime:'',
    async start(){this.blob=null;this.chunks=[];
      try{const st=await navigator.mediaDevices.getUserMedia({audio:true});
        this.mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(m=>window.MediaRecorder&&MediaRecorder.isTypeSupported(m))||'';
        this.mr=new MediaRecorder(st,this.mime?{mimeType:this.mime}:undefined);
        this.mr.ondataavailable=e=>{if(e.data&&e.data.size)this.chunks.push(e.data)};
        this.done=new Promise(r=>{this.mr.onstop=()=>{st.getTracks().forEach(t=>t.stop());this.blob=new Blob(this.chunks,{type:this.mr.mimeType||this.mime||'audio/webm'});r(this.blob)}});
        this.mr.start(1000);return true}catch(e){this.mr=null;return false}},
    async stop(){if(this.mr&&this.mr.state!=='inactive'){this.mr.stop();await this.done}this.mr=null;return this.blob},
    active(){return !!(this.mr&&this.mr.state==='recording')},
    async upload(){if(!this.blob||!this.blob.size)return'';if(!sb)return'';
      const ext=(this.blob.type.includes('mp4')?'m4a':this.blob.type.includes('ogg')?'ogg':'webm');
      const path=new Date().toISOString().slice(0,10)+'/'+Date.now().toString(36)+'.'+ext;
      const {error}=await sb.storage.from('recordings').upload(path,this.blob,{contentType:this.blob.type});
      if(error)return'';this.blob=null;return path},
    async url(path){if(!sb||!path)return'';const {data}=await sb.storage.from('recordings').createSignedUrl(path,3600);return data?.signedUrl||''}
  };
  window.__rec=rec;

  function makeDictation(){
    const h={partial:[],final:[],state:[]};let r=null,on=false,stopping=null;
    const emit=(k,v)=>h[k].forEach(f=>{try{f(v)}catch(e){}});
    return{
      speech:!!SR,
      start(opts={}){
        if(on)return Promise.resolve();on=true;emit('state',{state:'starting'});
        const p=rec.start();
        if(SR){r=new SR();r.lang=(opts.language==='he'?'he-IL':opts.language)||'he-IL';r.continuous=true;r.interimResults=true;
          r.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const x=e.results[i];if(x.isFinal)emit('final',{text:x[0].transcript});else interim+=x[0].transcript}if(interim)emit('partial',{text:interim})};
          r.onerror=e=>{if(e.error==='not-allowed'){on=false;emit('state',{state:'idle',reason:'not_granted'})}};
          r.onend=()=>{if(on&&!stopping){try{r.start()}catch(e){}}};
          try{r.start()}catch(e){}}
        return p.then(ok=>{if(!ok&&!SR){on=false;emit('state',{state:'idle',reason:'not_granted'});throw{code:'not_granted'}}emit('state',{state:'listening'})});
      },
      async stop(){if(!on)return;stopping=true;emit('state',{state:'finishing'});try{r&&r.stop()}catch(e){}await rec.stop();await new Promise(x=>setTimeout(x,400));on=false;stopping=null;emit('state',{state:'idle',reason:'stopped'})},
      active(){return on},
      onPartial(f){h.partial.push(f);return()=>{}},onFinal(f){h.final.push(f);return()=>{}},onState(f){h.state.push(f);return()=>{}}
    };
  }
  const dictation=(navigator.mediaDevices&&window.MediaRecorder)||SR?makeDictation():null;

  window.claude={use:async name=>{
    if(name==='db'){if(!sb)return null;await window.__gate;return makeDb()}
    if(name==='downloads')return downloads;
    if(name==='sample')return sb?sample:null;
    if(name==='dictation')return dictation;
    return null;
  }};
})();

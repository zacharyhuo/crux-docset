import test from 'node:test';
import assert from 'node:assert/strict';

test('finds emitted module packages, not loaders or unused orphans; includes concatenated children',async()=>{
  const m=await import('../src/spring/dokka-components.js').catch(()=>({}));
  assert.equal(typeof m.dokkaComponentPaths,'function');
  const root='/build/frontend';
  const result=m.dokkaComponentPaths({errors:[],modules:[
    {chunks:[1],nameForCondition:`${root}/src/main.ts`,modules:[
      {nameForCondition:`${root}/node_modules/@jetbrains/ring-ui/index.js`},
      {nameForCondition:`${root}/node_modules/a/node_modules/b/index.js`},
    ]},
    {chunks:[1],nameForCondition:`${root}/node_modules/react/index.js`,identifier:`${root}/node_modules/loader/index.js!${root}/node_modules/react/index.js`},
    {chunks:[],orphan:true,nameForCondition:`${root}/node_modules/unused/index.js`},
  ]},{root});
  assert.deepEqual(result,['node_modules/@jetbrains/ring-ui','node_modules/a/node_modules/b','node_modules/react']);
  assert.throws(()=>m.dokkaComponentPaths({errors:[{message:'build failed'}],modules:[]},{root}),/failed/i);
  assert.throws(()=>m.dokkaComponentPaths({errors:[],modules:[{chunks:[1],nameForCondition:'/elsewhere/node_modules/react/index.js'}]},{root}),/outside/i);
});

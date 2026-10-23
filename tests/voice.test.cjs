const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('../apps/tv/node_modules/typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { normalizeCommand, commandHeaders } = require('../apps/phone/voiceCommands.ts');
const { parseVoiceCommand, instructions, activityTitles, questions } = require('../packages/game-kit/coach.ts');
const audio = require('../apps/tv/android/app/src/main/assets/coach_voice.json');
test('every activity introduction and trivia prompt has bundled audio', () => {
  for (const activity of Object.keys(instructions)) { assert.ok(audio[instructions[activity]]); assert.ok(audio[`${activityTitles[activity]}. ${instructions[activity]}`]); }
  for (const q of questions) assert.ok(audio[`${q.text} Left: ${q.options[0]}. Right: ${q.options[1]}.`]);
  assert.ok(audio['Voice test. Your MoveQuest coach is ready.']);
});
test('bundled clips contain non-silent PCM data', () => {
  for(const [text,name] of Object.entries(audio)) {
    const b=fs.readFileSync(`apps/tv/android/app/src/main/res/raw/${name}.wav`);
    assert.equal(b.toString('ascii',0,4),'RIFF',text);
    let off=12, nonzero=0;
    while(off+8<=b.length) { const len=b.readUInt32LE(off+4); if(b.toString('ascii',off,off+4)==='data') { for(let i=off+8;i<Math.min(off+8+len,b.length);i++) if(b[i])nonzero++; break; } off+=8+len+(len%2); }
    assert.ok(nonzero>100,text);
  }
});
test('phone voice phrases are understood by the TV parser', () => {
  for(const text of ['Pause!','Resume','Start squats','jumping jacks','arm raises','freeze dance','mimic the pose','gesture trivia','start session','home','left','right','confirm']) assert.ok(parseVoiceCommand(normalizeCommand(text)),text);
  assert.equal(normalizeCommand('do not pause'),null); assert.equal(normalizeCommand('pause\r\nInject: test'),null);
});
test('relay encodes commands without injecting frame headers', () => {
  const headers=commandHeaders({id:2,text:'resume',expiresAt:10000},1000,text=>Buffer.from(text).toString('base64'));
  assert.match(headers,/X-MoveQuest-Command-Id: 2\r\n/);
  const encoded=headers.match(/X-MoveQuest-Command: (.+)\r\n/)[1];
  assert.equal(Buffer.from(encoded,'base64').toString(),'resume');
});
test('expired, missing and unsupported commands never enter the stream', () => {
  const encode=text=>Buffer.from(text).toString('base64');
  assert.equal(commandHeaders(undefined,0,encode),'');
  assert.equal(commandHeaders({id:1,text:'pause',expiresAt:1000},1000,encode),'');
  assert.equal(commandHeaders({id:1,text:'arbitrary text',expiresAt:10000},0,encode),'');
});

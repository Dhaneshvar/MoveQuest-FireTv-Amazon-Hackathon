// Collect the exact spoken UI phrases; synthesis is a separate, offline Windows step.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('../apps/tv/node_modules/typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const coach = require('../packages/game-kit/coach.ts');
const phrases = new Set(['Paused.', 'Resumed. Return to your starting position.', 'Session complete.', 'Round complete.', 'Rep', 'points', 'hundred', 'Stretch both arms sideways at shoulder height.', 'Reach both hands overhead.', 'MOVE', 'FREEZE', 'Voice test. Your MoveQuest coach is ready.']);
const numbers = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
numbers.forEach(word => phrases.add(word));
for (const activity of Object.keys(coach.instructions)) {
  phrases.add(coach.instructions[activity]); phrases.add(`${coach.activityTitles[activity]}. ${coach.instructions[activity]}`);
}
for (const question of coach.questions) {
  phrases.add(`${question.text} Left: ${question.options[0]}. Right: ${question.options[1]}.`);
  phrases.add(`The answer is ${question.options[question.answer]}.`);
}
const source = ts.createSourceFile('coach.ts', fs.readFileSync('packages/game-kit/coach.ts','utf8'), ts.ScriptTarget.Latest, true);
function visit(node) {
  if (ts.isStringLiteral(node) && /^[A-Z]/.test(node.text) && node.text.split(/\s+/).length >= 3) phrases.add(node.text);
  ts.forEachChild(node, visit);
}
visit(source);
const raw = 'apps/tv/android/app/src/main/res/raw'; fs.mkdirSync(raw,{recursive:true});
const mapping = Object.fromEntries([...phrases].sort().map(text=>[text, `coach_${crypto.createHash('sha256').update(text).digest('hex').slice(0,16)}`]));
fs.writeFileSync('apps/tv/android/app/src/main/assets/coach_voice.json', JSON.stringify(mapping,null,2)+'\n');
fs.mkdirSync('.gradle/coach-audio',{recursive:true});
fs.writeFileSync('.gradle/coach-audio/jobs.json', JSON.stringify(Object.entries(mapping).map(([text,name])=>({text,file:path.resolve(raw,name+'.wav')}))));
console.log(`Prepared ${phrases.size} offline voice clips.`);

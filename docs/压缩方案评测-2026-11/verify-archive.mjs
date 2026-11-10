/** 只读校验归档文件的SHA-256及核心记录数量，不依赖旧实验目录。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=async rel=>JSON.parse(await fs.readFile(path.join(root,rel),'utf8'));
const manifest=await read('archive-manifest.json');
for(const item of manifest.files){
  const file=path.resolve(root,item.path);
  if(!file.startsWith(root+path.sep))throw Error('归档路径越界');
  const data=await fs.readFile(file);
  if(data.length!==item.bytes||crypto.createHash('sha256').update(data).digest('hex')!==item.sha256)throw Error('归档文件发生变化：'+item.path);
}
const summary=await read('data/summary.json'),phone=await read('data/phone.json'),frames=await read('evidence/frame-metrics.json');
if(summary.length!==44||phone.length!==6||Object.keys(frames).length!==44)throw Error('核心记录数量不符');
for(const row of summary){const record=frames[row.clip+'-'+row.label];if(record.frames!==row.frames||record.perFrame.length!==row.frames)throw Error('逐帧指标数量不符');}
console.log(`归档校验通过：${manifest.files.length}个文件，44个PC版本，6个手机版，逐帧指标完整。`);

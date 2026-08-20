/** Reference spans as JSON, so the python probes can score against the same truth. */
import { writeFileSync } from 'node:fs'
import { dormReference, ninePmReference } from '../ground-truth'

const stem = process.argv[2]
const reference = stem === 'dorm-9pm' ? ninePmReference() : dormReference()
if (!reference) throw new Error(`no reference for ${stem}`)
writeFileSync(process.argv[3], JSON.stringify({
  spans: reference.spans,
  excluded: reference.excluded,
  truePeople: reference.truePeople,
}))
console.log(`${stem}: ${reference.spans.length} spans, ${reference.excluded.length} excluded, ${reference.truePeople} people`)

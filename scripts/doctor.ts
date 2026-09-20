import { loadConfig, deskRoot } from '../src/config.js'
import { runFullDoctor, formatDoctorReport } from '../src/doctor/doctor.js'

/** `npm run doctor` — the full pre-flight (cheap stages + tsc + test suite). Opens the hands gate on green. */
const cfg = loadConfig()
const report = await runFullDoctor(cfg, deskRoot())
console.log(formatDoctorReport(report))
process.exit(report.ok ? 0 : 1)
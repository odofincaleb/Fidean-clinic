import 'dotenv/config';
import { getClinicRepository } from '../repositories/index.js';

const repository = getClinicRepository();
const snapshot = await repository.seedCelonDemo();
console.log(JSON.stringify({ ok: true, snapshot }, null, 2));
await repository.close();

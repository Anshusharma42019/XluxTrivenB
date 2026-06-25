import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testTrack() {
  try {
    await smx.login();
    const trackRes = await smx.trackShipment('77852510890');
    console.log(JSON.stringify(trackRes, null, 2));
  } catch (err) {
    console.error(err.message);
  }
}
testTrack();

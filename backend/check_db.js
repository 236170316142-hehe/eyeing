const mongoose = require('mongoose');
require('dotenv').config();
const TrackingStatus = require('./models/TrackingStatus');

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const statuses = await TrackingStatus.find({});
  console.log(JSON.stringify(statuses, null, 2));
  process.exit(0);
}
check();

const mongoose = require('mongoose');

const setupProfileSchema = new mongoose.Schema({
  install_id: { type: String },
  device_id: { type: String, required: true, index: true },
  employee_id: { type: String, default: '' },
  company_id: { type: String, required: true, index: true },
  org_name: { type: String, default: '' },
  user_id: { type: String, required: true, index: true },
  login_email: { type: String, default: '' },
  designation: { type: String, default: '' },
  login_provider: { type: String, default: 'email' },
  backend_url: { type: String, default: '' },
  last_seen_at: { type: Date, default: Date.now }
}, { timestamps: true });

setupProfileSchema.index({ install_id: 1 }, { unique: true, sparse: true });
setupProfileSchema.index({ device_id: 1, updatedAt: -1 });

module.exports = mongoose.model('SetupProfile', setupProfileSchema);

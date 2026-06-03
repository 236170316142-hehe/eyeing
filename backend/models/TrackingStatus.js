const mongoose = require('mongoose');

const trackingStatusSchema = new mongoose.Schema({
  company_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  is_tracking_active: { type: Boolean, default: true },
  is_decommissioned: { type: Boolean, default: false },
  report_interval: { type: Number, default: 120 },
  last_seen_at: { type: Date, default: null },
  last_report_received_at: { type: Date, default: null },
  last_monitor_heartbeat_at: { type: Date, default: null },
  identity_resolved: { type: Boolean, default: false },
  queued_local_report_count: { type: Number, default: 0 },
  last_device_id: { type: String, default: '' },
  last_install_id: { type: String, default: '' },
  uninstall_requested_at: { type: Date, default: null },
  decommission_requested_at: { type: Date, default: null },
  last_updated_by: { type: String, default: 'admin' }
}, { timestamps: true });

// Ensure unique toggle per user per company
trackingStatusSchema.index({ company_id: 1, user_id: 1 }, { unique: true });

module.exports = mongoose.model('TrackingStatus', trackingStatusSchema);

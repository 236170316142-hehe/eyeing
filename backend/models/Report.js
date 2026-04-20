const mongoose = require('mongoose');

// The Report schema captures the company -> user hierarchy as requested
const reportSchema = new mongoose.Schema({
  company_id: { type: String, required: true, index: true },
  org_name: { type: String },
  user_id: { type: String, required: true, index: true },
  employee_id: { type: String },
  designation: { type: String },
  device_id: { type: String },
  timestamp: { type: String, index: true },
  
  active_app: String,
  window_title: String,
  tab_url: String,
  
  time_active_sec: Number,
  time_idle_sec: Number,
  app_time_breakdown: mongoose.Schema.Types.Mixed,
  
  clipboard_copies: Number,
  clipboard_pastes: Number,
  clipboard_cuts: Number,
  clipboard_source_apps: [String],
  clipboard_dest_apps: [String],
  
  keyboard_active: Boolean,
  keyboard_key_presses: Number,
  keyboard_bursts: Number,
  mouse_active: Boolean,
  mouse_clicks: Number,
  
  app_switches: Number,
  switch_sequence: [String],
  
  ocr_confidence_mean: Number,
  ocr_confidence_label: String,
  ocr_word_count: Number,
  ocr_text: String,
  ocr_embedding: [Number],
  
  browser_tabs_count: Number,
  open_tabs: [String]
}, { timestamps: true });

// Setting up compound index for querying by company and user hierarchy efficiently
reportSchema.index({ company_id: 1, user_id: 1, timestamp: -1 });

module.exports = mongoose.model('Report', reportSchema);

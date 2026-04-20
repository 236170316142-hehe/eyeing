const mongoose = require('mongoose');

const summarySchema = new mongoose.Schema({
  company_id: { type: String, required: true },
  user_id: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  content: { type: String, required: true }, // The AI generated markdown
  summary_type: { type: String, default: 'daily' }, // daily, weekly
  metadata: {
    characters_processed: Number,
    last_updated: { type: Date, default: Date.now }
  }
}, { timestamps: true });

summarySchema.index({ company_id: 1, user_id: 1, date: -1 });

module.exports = mongoose.model('Summary', summarySchema);

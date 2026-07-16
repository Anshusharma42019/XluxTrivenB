import { sendWhatsAppMessage } from '../interakt/interakt.service.js';
import { BulkMessageBatch, BulkMessageRecipient } from './bulkMessage.model.js';
import Lead from './lead.model.js';
import { config } from 'dotenv';
config();

const throttleRate = parseInt(process.env.BULK_WHATSAPP_RATE_LIMIT) || 20;
// Calculate milliseconds to wait between each message to respect rate limit (e.g., 20/min = 1 every 3 seconds)
const intervalMs = Math.floor(60000 / throttleRate);

const queue = [];
let isProcessing = false;

const processNext = async () => {
  if (queue.length === 0) {
    isProcessing = false;
    return;
  }
  isProcessing = true;
  const job = queue.shift();
  
  try {
     await processJob(job);
  } catch(e) {
     console.error('Job processing error:', e);
  }
  
  // Wait before processing next to enforce rate limit
  setTimeout(processNext, intervalMs);
};

export const bulkMessageQueue = {
  add: async (name, data) => {
    queue.push(data);
    if (!isProcessing) {
       processNext();
    }
  },
  addBulk: async (jobs) => {
    for (const job of jobs) {
      queue.push(job.data);
    }
    if (!isProcessing && queue.length > 0) {
       processNext();
    }
  }
};

const processJob = async (data) => {
  const { batchId, leadId, templateName, phone, name } = data;
  
  // The Interakt templates for this org only expect 1 body variable (e.g. {{1}} = Customer Name).
  // Passing more causes a 400 Bad Request error from Interakt.
  const bodyValues = [
    name || 'Customer'
  ];

  try {
    await sendWhatsAppMessage({ 
      phone, 
      templateName, 
      bodyValues 
    });
    
    await BulkMessageRecipient.findOneAndUpdate(
      { batch_id: batchId, lead_id: leadId },
      { status: 'sent', sent_at: new Date() }
    );
    
    await BulkMessageBatch.findByIdAndUpdate(batchId, { $inc: { sent_count: 1 } });
    await Lead.findByIdAndUpdate(leadId, { lastWhatsAppMessagedAt: new Date(), lastMessageWasBulk: true });
    
    // console.log(`[Bulk] Sent msg to ${phone}`);
  } catch (error) {
    // console.error(`Bulk WhatsApp Send Failed for Lead ${leadId}:`, error?.response?.data || error.message);
    const errorMsg = error?.response?.data?.message || error.message || 'Unknown error';
    
    await BulkMessageRecipient.findOneAndUpdate(
      { batch_id: batchId, lead_id: leadId },
      { status: 'failed', error_reason: errorMsg }
    );
    
    await BulkMessageBatch.findByIdAndUpdate(batchId, { $inc: { failed_count: 1 } });
  }
  
  // Check if batch is completed
  const batch = await BulkMessageBatch.findById(batchId);
  if (batch && (batch.sent_count + batch.failed_count + batch.excluded_count) >= batch.total) {
     await BulkMessageBatch.findByIdAndUpdate(batchId, { status: 'completed', completed_at: new Date() });
     // console.log(`[Bulk] Batch ${batchId} Completed!`);
  }
};

export default bulkMessageQueue;

import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema({
  name: String, 
  sku: String, 
  units: Number,
  selling_price: mongoose.Schema.Types.Mixed,
  discount: String, 
  tax: String, 
  hsn: String,
}, { _id: false });

const shipmaxxOrderSchema = new mongoose.Schema({
  order_id: { type: String, unique: true, sparse: true, index: true },
  awb_code: { type: String, index: true },
  courier_name: String,
  status: { type: String, default: 'NEW' },
  delivery_attempt: { type: Number, default: 1 },
  
  billing_customer_name: String,
  billing_phone: String,
  billing_email: String,
  billing_address: String,
  billing_city: String,
  billing_state: String,
  billing_pincode: mongoose.Schema.Types.Mixed,
  billing_country: { type: String, default: 'India' },
  
  shipping_is_billing: { type: Boolean, default: true },
  shipping_address: String,
  shipping_city: String,
  shipping_state: String,
  shipping_pincode: mongoose.Schema.Types.Mixed,
  
  order_items: [orderItemSchema],
  payment_method: String,
  sub_total: Number,
  
  length: Number, breadth: Number, height: Number, weight: Number,
  
  lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  
  status_updated_at: { type: Date, index: true },
  delivered_at: { type: Date, index: true },
  platform: { type: String, default: 'shipmaxx', index: true },
  
  verified_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  commission_generated: { type: Boolean, default: false, index: true },
  commission_generated_at: Date,
  follow_ups: [{
    date: Date,
    note: String,
    auto: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  }],
  next_follow_up: Date,
  auto_followups_set: { type: Boolean, default: false },
  problem: { type: String, default: '' },
  notes: { type: String, default: '' },
  comments: [{
    text: { type: String, required: true },
    type: { type: String, enum: ['general', 'followup'], default: 'general' },
    section: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  }],
  followup_done: { type: Boolean, default: false },
  sent_to_verification: { type: Boolean, default: false },
  source_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShipmaxxOrder', default: null },
  reorder_commission_generated: { type: Boolean, default: false },
  
  raw_response: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

shipmaxxOrderSchema.statics.updateWithTransaction = async function (query, update, options = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const doc = await this.findOneAndUpdate(query, update, { ...options, new: true, session });
    
    if (doc) {
      const isDelivered = /^delivered$/i.test(doc.status);
      const isRto = /^rto/i.test(doc.status);
      
      let DeliveredModel, InTransitModel, RtoModel;
      try { DeliveredModel = mongoose.model('ShipmaxxDeliveredOrder'); } catch(e) {}
      try { InTransitModel = mongoose.model('ShipmaxxInTransitOrder'); } catch(e) {}
      try { RtoModel = mongoose.model('ShipmaxxRtoOrder'); } catch(e) {}
      
      const data = {
        order_id: doc.order_id,
        billing_customer_name: doc.billing_customer_name || '',
        billing_phone: doc.billing_phone || '',
        billing_email: doc.billing_email || '',
        billing_address: doc.billing_address || '',
        billing_city: doc.billing_city || '',
        billing_state: doc.billing_state || '',
        billing_pincode: doc.billing_pincode || '',
        awb_code: doc.awb_code || '',
        courier_name: doc.courier_name || '',
        payment_method: doc.payment_method || '',
        sub_total: doc.sub_total || 0,
        order_items: doc.order_items || [],
        status: doc.status,
        lead_id: doc.lead_id || null,
        status_updated_at: doc.status_updated_at || doc.createdAt,
        order_date: doc.createdAt
      };

      if (isDelivered) {
        data.delivered_at = doc.delivered_at || doc.createdAt;
        if (DeliveredModel) await DeliveredModel.findOneAndUpdate({ order_id: doc.order_id }, { $set: data }, { upsert: true, session });
        if (InTransitModel) await InTransitModel.deleteOne({ order_id: doc.order_id }, { session });
      } else if (isRto) {
        if (RtoModel) await RtoModel.findOneAndUpdate({ order_id: doc.order_id }, { $set: data }, { upsert: true, session });
        if (InTransitModel) await InTransitModel.deleteOne({ order_id: doc.order_id }, { session });
      } else {
        if (InTransitModel) await InTransitModel.findOneAndUpdate({ order_id: doc.order_id }, { $set: data }, { upsert: true, session });
      }
    }

    await session.commitTransaction();
    return doc;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

export const ShipmaxxOrder = mongoose.model('ShipmaxxOrder', shipmaxxOrderSchema);

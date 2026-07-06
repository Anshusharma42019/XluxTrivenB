import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import Lead from '../lead/lead.model.js';
import User from '../user/user.model.js';
import * as leadService from '../lead/lead.service.js';
import streamifier from 'streamifier';
import cloudinary from '../../config/cloudinary.js';
import { sendWhatsAppMessage, sendInteraktChatMessage, getApprovedTemplates } from './interakt.service.js';

/**
 * Handle incoming webhooks from Interakt
 */
const handleWebhook = catchAsync(async (req, res) => {
  const payload = req.body;

  console.log(`[Interakt Webhook] Received:`, JSON.stringify(payload, null, 2));

  if (!payload || (!payload.entityType && !payload.type)) {
    return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'Invalid payload'));
  }

  try {
    const isMessage = payload.entityType === 'USER_MESSAGE' || payload.type === 'message_received';
    
    if (isMessage) {
      let phone, messageText, customerName, targetDepartment = null;
      
      if (payload.type === 'message_received' && payload.data) {
        phone = payload.data.customer?.phone_number || payload.data.customer?.phone;
        customerName = payload.data.customer?.traits?.name || `WhatsApp Lead (${phone})`;
        
        const msgObj = payload.data.message;
        let extractedText = "";
        
        if (typeof msgObj?.message === 'string') {
          extractedText = msgObj.message;
        } else if (msgObj?.message?.text) {
          extractedText = msgObj.message.text;
        } else if (msgObj?.text) {
          extractedText = msgObj.text;
        }

        let referralText = "";
        if (msgObj?.referral?.headline) {
          referralText = `\n[Clicked Ad: ${msgObj.referral.headline}]`;
        }

        messageText = extractedText ? (extractedText + referralText) : (msgObj ? JSON.stringify(msgObj) : "New message received");

        let businessPhone = payload.data?.customer?.channel_phone_number || "";
        
        const fallbackMigraine = "7309523829,917309523829,916376776399,6376776399";
        const migraineNumbers = (process.env.INTERAKT_MIGRAINE_NUMBERS || fallbackMigraine).split(",");
        const haircareNumbers = (process.env.INTERAKT_HAIRCARE_NUMBERS || "").split(",");
        
        // 1. Keyword based routing (Highest Priority)
        const textToCheck = messageText.toLowerCase();
        
        const pilesKeywords = [
            "khoon ata hai", "fissure hai", "masse hai ander", "bhagandar hai", "fistula hai", 
            "pus ata hai", "gas hai pet me", "bhar masse hai", "khujli hoti hai", "pet saf nhi hota hai", 
            "bawasir ki dawa", "bawasir ka ilaj", "khuni bawasir ki dawa", "khuni bawasir ka ilaj", 
            "masse ki dawa", "masse ka ilaj", "piles ki dawa", "piles ka ilaj", "hemorrhoids treatment", 
            "hemorrhoids medicine", "fissure ki dawa", "fissure ka ilaj", "guda me dard ki dawa", 
            "guda se khoon aana ilaj", "potty ke time khoon aana", "potty ke time dard", "guda me sujan", 
            "guda me jalan", "guda me khujli", "external piles treatment", "external hemorrhoids treatment",
            "piles", "bawasir", "bawaseer", "fissure", "hemorrhoid", "fistula"
        ];

        const migraineKeywords = [
            "migraine ka ilaj", "migraine ki dawa", "aadhe sir dard ka ilaj", "aadhe sir dard ki dawa", 
            "sir dard ki dawa", "migraine treatment", "migraine medicine", "migraine pain relief", 
            "migraine attack treatment", "migraine ayurvedic treatment",
            "migraine", "headache", "sir dard", "sirdard", "sir me dard"
        ];

        if (pilesKeywords.some(keyword => textToCheck.includes(keyword))) {
            targetDepartment = 'piles';
        } else if (migraineKeywords.some(keyword => textToCheck.includes(keyword))) {
            targetDepartment = 'migraine';
        }
        // 2. Business Phone Number based routing (Fallback)
        else if (businessPhone && migraineNumbers.some(num => num.trim() !== "" && businessPhone.includes(num.trim()))) {
            targetDepartment = 'migraine';
        } else if (businessPhone && haircareNumbers.some(num => num.trim() !== "" && businessPhone.includes(num.trim()))) {
            targetDepartment = 'haircare';
        }
        
      } else {
        phone = payload.userPhoneNumber;
        customerName = `WhatsApp Lead (${phone})`;
        messageText = payload.message?.text || payload.entity?.text || payload.entity?.suggestionResponse?.postBack?.data || "New message received";
      }

      console.log(`[Interakt Webhook] User ${customerName} (${phone}) | dept: ${targetDepartment}`);
      
      if (phone && messageText) {
        // Normalize phone — strip +91 / 91 country code prefix, keep last 10 digits
        let normalizedPhone = phone.replace(/\s+/g, '');
        if (normalizedPhone.startsWith('+91')) normalizedPhone = normalizedPhone.substring(3);
        else if (normalizedPhone.startsWith('91') && normalizedPhone.length === 12) normalizedPhone = normalizedPhone.substring(2);
        else if (normalizedPhone.startsWith('+')) normalizedPhone = normalizedPhone.substring(1);
        normalizedPhone = normalizedPhone.slice(-10); // always use last 10 digits

        // Search only active (non-deleted) leads — match last 10 digits
        let lead = await Lead.findOne({
          phone: { $regex: normalizedPhone + '$' },
          isDeleted: false,
        });

        const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }).select('_id').lean();
        
        if (!lead) {
          console.log(`[Interakt Webhook] Auto-creating new lead for phone ${normalizedPhone}`);
          const newLeadData = {
            name: customerName,
            phone: normalizedPhone,
            source: 'social_media',
            department: targetDepartment,
            problem: `[Interakt Message] ${messageText}`,
            status: 'new'
          };
          
          try {
            await leadService.createLead(newLeadData, defaultAdmin ? defaultAdmin._id : null, 'admin');
          } catch (createErr) {
            // If duplicate phone conflict — find that lead and add a note instead
            if (createErr.statusCode === 409 || createErr.message?.includes('already exists')) {
              console.log(`[Interakt Webhook] Lead already exists (race condition) — adding note instead`);
              lead = await Lead.findOne({ phone: { $regex: normalizedPhone + '$' }, isDeleted: false });
              if (lead) {
                lead.notes.push({ text: `[Interakt Message] ${messageText}`, direction: 'inbound' });
                await lead.save();
              }
            } else {
              throw createErr;
            }
          }
        } else {
          console.log(`[Interakt Webhook] Adding note to existing lead ${lead._id}`);
          lead.notes.push({
            text: `[Interakt Message] ${messageText}`,
            direction: 'inbound',
          });
          await lead.save();
        }
      }
    } else {
      console.log(`[Interakt Webhook] Received unhandled event: ${payload.entityType || payload.type}`);
    }
  } catch (error) {
    console.error(`[Interakt Webhook Error]`, error);
  }

  // Always return 200 OK to acknowledge receipt of the webhook to Interakt
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, null, 'Webhook received successfully'));
});

/**
 * Send a WhatsApp message to a lead via Interakt
 */
const sendMessage = catchAsync(async (req, res) => {
  const { leadId, message, templateName, languageCode, useStandardChat } = req.body;

  if (!leadId) {
    return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'leadId is required'));
  }

  const lead = await Lead.findById(leadId);
  if (!lead) {
    return res.status(httpStatus.NOT_FOUND).json(new ApiResponse(httpStatus.NOT_FOUND, null, 'Lead not found'));
  }

  let mediaUrl = null;

  // Handle file upload if present
  if (req.file) {
    try {
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'interakt-media',
            resource_type: 'auto'
          },
          (error, result) => {
            if (error) return reject(new Error('Cloudinary upload failed'));
            resolve(result);
          }
        );
        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
      });
      mediaUrl = uploadResult.secure_url;
    } catch (error) {
      console.error('[Cloudinary Error]', error);
      return res.status(httpStatus.INTERNAL_SERVER_ERROR).json(new ApiResponse(httpStatus.INTERNAL_SERVER_ERROR, null, 'Failed to upload media'));
    }
  }

  // Send WhatsApp via Interakt
  let interaktResult = null;
  try {
    if (mediaUrl || useStandardChat === 'true' || useStandardChat === true) {
      // Use standard chat message API for attachments
      interaktResult = await sendInteraktChatMessage({
        phone: lead.phone,
        messageText: message || '',
        mediaUrl: mediaUrl
      });
    } else {
      // Use standard template API
      if (!message) {
        return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'message is required for templates'));
      }
      interaktResult = await sendWhatsAppMessage({
        phone: lead.phone,
        messageText: message,
        templateName,
        languageCode,
      });
    }
  } catch (err) {
    console.error('[Interakt] sendMessage failed:', err?.response?.data || err.message);
    // Don't block — still save the note so staff have a record
    interaktResult = { error: err?.response?.data?.message || err.message };
  }

  // Save outbound note
  const sentBy = req.user?._id || null;
  
  let noteText = message || '';
  if (interaktResult && interaktResult.error) {
    noteText = `[FAILED] ${noteText}`;
  }
  if (mediaUrl) {
    noteText = `[Attached Media: ${mediaUrl}] ${noteText}`;
  }

  lead.notes.push({
    text: noteText,
    createdBy: sentBy,
    direction: 'outbound',
  });
  await lead.save();

  const savedNote = lead.notes[lead.notes.length - 1];
  return res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, { note: savedNote, interaktResult }, 'Message sent'));
});

export default {
  handleWebhook,
  sendMessage,
  testWebhook: catchAsync(async (req, res) => {
    let lead = await Lead.findOne({ phone: "8888888888" });
    const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }).select('_id').lean();
    if (!lead) {
      const newLeadData = {
        name: `WhatsApp Lead (8888888888)`,
        phone: "8888888888",
        source: 'social_media',
        problem: `[Interakt Message] TEST`,
        status: 'new'
      };
      lead = await leadService.createLead(newLeadData, defaultAdmin ? defaultAdmin._id : null, 'admin');
      res.status(200).json({ success: true, message: "Lead CREATED", lead });
    } else {
      res.status(200).json({ success: true, message: "Lead ALREADY EXISTS", lead });
    }
  }),
  latestLeads: catchAsync(async (req, res) => {
    const leads = await Lead.find({ source: 'social_media' }).sort({ createdAt: -1 }).limit(10).lean();
    res.status(200).json({ success: true, leads });
  }),
  getTemplates: catchAsync(async (req, res) => {
    const templates = await getApprovedTemplates();
    res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, { templates }, 'Templates fetched successfully'));
  })
};

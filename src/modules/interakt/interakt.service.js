import axios from 'axios';
import { config } from 'dotenv';
import crypto from 'crypto';
config();

const INTERAKT_API_KEY = process.env.INTERAKT_API_KEY;

// Ensure we have a valid key, otherwise log a warning
if (!INTERAKT_API_KEY) {
  console.warn('⚠️ INTERAKT_API_KEY is not defined in .env. Interakt APIs will fail.');
}

const getHeaders = () => ({
  'Authorization': `Basic ${INTERAKT_API_KEY}`,
  'Content-Type': 'application/json'
});

/**
 * Track a User in Interakt
 * @param {Object} lead - The lead document
 */
export const trackUser = async (lead) => {
  if (!INTERAKT_API_KEY || !lead.phone) return;
  try {
    // Interakt expects countryCode and phoneNumber. Assuming standard 10 digit indian phone numbers with +91 country code.
    let phone = lead.phone.trim();
    let countryCode = '+91';
    
    if (phone.startsWith('+')) {
      countryCode = phone.substring(0, 3);
      phone = phone.substring(3);
    }

    const payload = {
      userId: String(lead._id),
      countryCode,
      phoneNumber: phone,
      traits: {
        name: lead.name,
        email: lead.email,
        department: lead.department || 'General',
        status: lead.status,
        source: lead.source || 'Manual',
        problem: lead.problem || ''
      }
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/track/users/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Interakt Track User Error:', error?.response?.data || error.message);
  }
};

/**
 * Track an Event for a User in Interakt
 * @param {String} leadId - The lead document ID
 * @param {String} eventName - The name of the event
 * @param {Object} traits - Additional traits to attach to the event
 */
export const trackEvent = async (leadId, eventName, traits = {}) => {
  if (!INTERAKT_API_KEY || !leadId) return;
  try {
    const payload = {
      userId: String(leadId),
      event: eventName,
      traits: traits
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/track/events/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error(`Interakt Track Event (${eventName}) Error:`, error?.response?.data || error.message);
  }
};

/**
 * Send an RCS Standalone or Carousel Message with SMS Fallback
 * @param {Object} params - parameters for sending RCS
 */
export const sendRcsMessage = async ({ countryCode = '+91', phoneNumber, cardTitle, cardDescription, mediaUrl, suggestions = [], smsFallbackContent, dltTemplateId, variables = [] }) => {
  if (!INTERAKT_API_KEY) return;
  try {
    const payload = {
      countryCode,
      phoneNumber,
      message: {
        richCardDetails: {
          standalone: {
            cardOrientation: "VERTICAL",
            content: {
              cardTitle,
              cardDescription,
              cardMedia: mediaUrl ? {
                mediaHeight: "TALL",
                contentInfo: {
                  fileUrl: mediaUrl
                }
              } : undefined,
              suggestions: suggestions.map(sug => ({
                reply: {
                  plainText: sug.text,
                  postBack: {
                    data: sug.data
                  }
                }
              }))
            }
          }
        }
      },
      type: "STANDALONE_CAROUSEL",
      fallback: [
        {
          channel: "sms",
          sender_id: "INTRKT", // Should be replaced with actual DLT Sender ID
          pe_id: "1201159195599372920", // Default from Interakt Docs
          provider_name: "default",
          content: {
            message: smsFallbackContent,
            dlt_te_id: dltTemplateId,
            variables: variables
          }
        }
      ]
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/rcs/message/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Interakt Send RCS Message Error:', error?.response?.data || error.message);
  }
};

/**
 * Send an RCS Template Message with SMS Fallback
 */
export const sendRcsTemplate = async ({ phone, templateName, languageCode = 'en', carouselCards = [], campaignId, smsFallbackContent, dltTemplateId, variables = [] }) => {
  if (!INTERAKT_API_KEY) throw new Error('INTERAKT_API_KEY not configured');
  
  let cleanPhone = phone.trim();
  let countryCode = '91';
  
  if (cleanPhone.startsWith('+91')) cleanPhone = cleanPhone.substring(3);
  else if (cleanPhone.startsWith('91') && cleanPhone.length === 12) cleanPhone = cleanPhone.substring(2);
  else if (cleanPhone.startsWith('+')) {
    const match = cleanPhone.match(/^\+(\d{1,3})(\d+)$/);
    if (match) { countryCode = match[1]; cleanPhone = match[2]; }
  }
  cleanPhone = cleanPhone.slice(-10);

  const payload = {
    countryCode: `+${countryCode}`,
    phoneNumber: cleanPhone,
    template: {
      name: templateName,
      languageCode,
      carouselCards: carouselCards.map(card => ({
        bodyValues: card.bodyValues
      }))
    },
    type: "Template",
    fallback: [
      {
        channel: "sms",
        sender_id: process.env.DLT_SMS_SENDER_ID || "INTRKT",
        pe_id: process.env.DLT_PROVIDER_ENTITY_ID || "1201159195599372920",
        provider_name: "default",
        content: {
          message: smsFallbackContent || process.env.DLT_SMS_CONTENT || 'Thank you for contacting us.',
          dlt_te_id: dltTemplateId || process.env.DLT_TEMPLATE_ID || '1107174012164676172',
          variables: variables
        }
      }
    ]
  };

  if (campaignId) {
    payload.campaignId = campaignId;
  }

  const response = await axios.post('https://api.interakt.ai/v1/public/rcs/message/', payload, { headers: getHeaders() });
  return response.data;
};

/**
 * Send a WhatsApp message via Interakt template API
 * @param {string} phone - 10-digit Indian phone number
 * @param {string} messageText - The text to send (goes into template body variable {{1}})
 * @param {string} templateName - Interakt pre-approved template name
 * @param {string} languageCode - Template language code
 */
export const sendWhatsAppMessage = async ({ phone, messageText, bodyValues, templateName, languageCode = 'en' }) => {
  if (!INTERAKT_API_KEY) throw new Error('INTERAKT_API_KEY not configured');
  
  let cleanPhone = phone.trim();
  let countryCode = '91';
  
  if (cleanPhone.startsWith('+91')) cleanPhone = cleanPhone.substring(3);
  else if (cleanPhone.startsWith('91') && cleanPhone.length === 12) cleanPhone = cleanPhone.substring(2);
  else if (cleanPhone.startsWith('+')) {
    // extract country code
    const match = cleanPhone.match(/^\+(\d{1,3})(\d+)$/);
    if (match) { countryCode = match[1]; cleanPhone = match[2]; }
  }
  cleanPhone = cleanPhone.slice(-10); // ensure 10 digits

  const template = templateName || process.env.INTERAKT_WA_TEMPLATE || 'hello_world';

  // Accept either a pre-built bodyValues array or a single messageText string
  const finalBodyValues = Array.isArray(bodyValues) ? bodyValues : [messageText];

  const payload = {
    countryCode: `+${countryCode}`,
    phoneNumber: cleanPhone,
    callbackData: 'crm_outbound',
    type: 'Template',
    template: {
      name: template,
      languageCode,
      bodyValues: finalBodyValues,
    },
  };

  const response = await axios.post('https://api.interakt.ai/v1/public/message/', payload, { headers: getHeaders() });
  return response.data;
};

/**
 * Send a standard WhatsApp chat message (requires active 24-hour window)
 * @param {string} phone - 10-digit Indian phone number
 * @param {string} messageText - The text to send
 * @param {string} mediaUrl - Optional public URL of the media
 */
export const sendInteraktChatMessage = async ({ phone, messageText, mediaUrl }) => {
  if (!INTERAKT_API_KEY) throw new Error('INTERAKT_API_KEY not configured');
  
  let cleanPhone = phone.trim();
  let countryCode = '91';
  
  if (cleanPhone.startsWith('+91')) cleanPhone = cleanPhone.substring(3);
  else if (cleanPhone.startsWith('91') && cleanPhone.length === 12) cleanPhone = cleanPhone.substring(2);
  else if (cleanPhone.startsWith('+')) {
    const match = cleanPhone.match(/^\+(\d{1,3})(\d+)$/);
    if (match) { countryCode = match[1]; cleanPhone = match[2]; }
  }
  cleanPhone = cleanPhone.slice(-10);

  const payload = {
    countryCode: `+${countryCode}`,
    phoneNumber: cleanPhone,
    callbackData: 'crm_outbound',
  };

  if (mediaUrl) {
    let type = 'Image';
    if (mediaUrl.match(/\.(mp4|mov|avi)$/i)) type = 'Video';
    else if (mediaUrl.match(/\.(pdf|doc|docx|txt|xls|xlsx)$/i)) type = 'Document';
    else if (mediaUrl.includes('raw/upload') || mediaUrl.includes('/raw/')) type = 'Document';
    else if (mediaUrl.includes('/video/')) type = 'Video';
    
    payload.type = type;
    payload.data = {
      mediaUrl: mediaUrl
    };
    if (messageText) {
      payload.data.caption = messageText;
    }
  } else {
    payload.type = 'Text';
    payload.data = {
      message: messageText
    };
  }

  const response = await axios.post('https://api.interakt.ai/v1/public/message/', payload, { headers: getHeaders() });
  return response.data;
};

/**
 * Fetch list of approved WhatsApp templates from Interakt
 */
export const getApprovedTemplates = async () => {
  if (!INTERAKT_API_KEY) return [];
  try {
    const response = await axios.get('https://api.interakt.ai/v1/public/track/organization/templates', { headers: getHeaders() });
    const templates = response.data?.results?.templates || [];
    return templates.filter(t => t.status === 'APPROVED' || t.status === 'approved');
  } catch (error) {
    console.error('Interakt Get Templates Error:', error?.response?.data || error.message);
    return [];
  }
};

/**
 * Smart WhatsApp dispatch sender - tries template first, falls back to chat message
 * @param {string} phone - Customer phone number
 * @param {string} customerName - Customer name
 * @param {string} orderTitle - Order/booking title
 * @param {string} price - Order price
 */
export const sendDispatchNotification = async ({ phone, customerName, orderTitle, price }) => {
  if (!INTERAKT_API_KEY || !phone) return;

  // Check if a specific dispatch template is configured in .env
  const envTemplate = process.env.INTERAKT_DISPATCH_TEMPLATE;

  if (envTemplate && envTemplate !== 'hello_world') {
    // Use configured template directly
    try {
      const messageText = `${customerName} - आपकी बुकिंग verified हो गई है और जल्द ही dispatch होगी।`;
      const result = await sendWhatsAppMessage({ phone, messageText, templateName: envTemplate, languageCode: 'en' });
      console.log(`✅ WhatsApp dispatch message sent to ${phone} using template '${envTemplate}'`);
      return result;
    } catch (err) {
      console.error(`⚠️ Template '${envTemplate}' failed:`, err?.response?.data || err.message);
    }
  }

  // No env template configured - fetch approved templates dynamically
  const approvedTemplates = await getApprovedTemplates();

  if (approvedTemplates.length > 0) {
    const template = approvedTemplates[0];
    console.log(`[WhatsApp] Using approved template: '${template.name}'`);
    try {
      const messageText = `${customerName} - आपकी बुकिंग verified हो गई है और जल्द ही dispatch होगी।`;
      const result = await sendWhatsAppMessage({ phone, messageText, templateName: template.name, languageCode: template.language || 'en' });
      console.log(`✅ WhatsApp dispatch message sent to ${phone} using template '${template.name}'`);
      return result;
    } catch (err) {
      console.error(`⚠️ Template message failed:`, err?.response?.data || err.message);
    }
  }

  // No templates - try chat message (works only if customer messaged in 24hrs)
  console.warn('⚠️ [WhatsApp] No approved templates found in Interakt account!');
  try {
    const chatMsg = `नमस्ते ${customerName} जी! 🎉 आपकी बुकिंग verified हो गई है और जल्द ही dispatch हो जाएगी। ऑर्डर: ${orderTitle || 'Order'}, कीमत: ₹${price || 'N/A'}। धन्यवाद! 🙏`;
    const result = await sendInteraktChatMessage({ phone, messageText: chatMsg });
    console.log(`✅ WhatsApp chat message sent to ${phone}`);
    return result;
  } catch (chatErr) {
    const errMsg = chatErr?.response?.data?.message || chatErr.message;
    if (errMsg?.includes('24 hours')) {
      console.error('❌ [WhatsApp] FAILED: Customer not active in 24hrs AND no approved template exists.');
      console.error('👉 FIX: Create a WhatsApp template on Interakt:');
      console.error('   1. Go to https://app.interakt.ai → Templates → New Template');
      console.error('   2. Body: "नमस्ते {{1}} जी! आपकी बुकिंग dispatch हो चुकी है।"');
      console.error('   3. After approval, set INTERAKT_DISPATCH_TEMPLATE=<template_name> in .env');
    } else {
      console.error('❌ [WhatsApp] Failed:', errMsg);
    }
  }
};


/**
 * Send a WhatsApp verification confirmation message to the lead
 * Passes all lead details (problem, price, address, name) as template variables.
 *
 * booking_ template variable order:
 *   {{1}} = problem  (e.g. "सिर दर्द एवं माइग्रेन")
 *   {{2}} = price    (e.g. "1499")
 *   {{3}} = address  (full delivery address)
 *   {{4}} = name     (customer name)
 */
export const sendVerificationConfirmation = async ({
  phone, customerName, problem, price, address, templateName
}) => {
  if (!INTERAKT_API_KEY || !phone) return;

  const tmplName = templateName || process.env.INTERAKT_VERIFICATION_TEMPLATE || process.env.INTERAKT_WA_TEMPLATE || 'hello_world';
  const tmplLang = process.env.INTERAKT_VERIFICATION_LANG || 'hi';

  // Build the 4 bodyValues matching booking_ template placeholders
  const bodyValues = [
    problem  || 'उपचार',                    // {{1}} problem / treatment
    String(price || ''),                     // {{2}} price
    address  || '',                          // {{3}} delivery address
    customerName || 'Customer',              // {{4}} customer name
  ];

  try {
    const result = await sendWhatsAppMessage({ phone, bodyValues, templateName: tmplName, languageCode: tmplLang });
    console.log(`[WhatsApp] Verification confirmation sent to ${phone} | problem=${problem} price=${price}`);
    return result;
  } catch (templateErr) {
    console.warn(`[WhatsApp] Template failed for verification confirmation:`, templateErr?.response?.data || templateErr.message);
    // Fallback: plain chat message (needs 24-hr active window)
    try {
      const fallbackMsg = `नमस्कार ${customerName || ''} जी! आपका Treatment Plan बुक हो गया है। समस्या: ${problem || ''}, मूल्य: ₹${price || ''}। पते पर: ${address || ''}। कृपया YES या NO में जवाब दें।`;
      const result = await sendInteraktChatMessage({ phone, messageText: fallbackMsg });
      console.log(`[WhatsApp] Verification confirmation (chat fallback) sent to ${phone}`);
      return result;
    } catch (chatErr) {
      console.error(`[WhatsApp] Verification confirmation FAILED for ${phone}:`, chatErr?.response?.data || chatErr.message);
    }
  }
};

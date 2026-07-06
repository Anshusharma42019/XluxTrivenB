import express from 'express';
import interaktController from './interakt.controller.js';
import { debugTasks } from './interakt.debug.js';
import auth from '../../middleware/auth.js';
import upload from '../../middleware/upload.js';

const router = express.Router();

// Route to handle webhooks sent from Interakt
router.post('/webhook', interaktController.handleWebhook);
router.get('/webhook', (req, res) => res.status(200).send('OK'));
router.get('/debug-tasks', debugTasks);
router.get('/latest-leads', interaktController.latestLeads);
router.get('/templates', auth(), interaktController.getTemplates);

// Send a WhatsApp message to a lead via Interakt
router.post('/send-message', auth(), upload.single('media'), interaktController.sendMessage);

export default router;

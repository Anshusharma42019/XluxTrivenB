import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './integrations.controller.js';

const router = express.Router();

router.post('/setPassword', auth(), c.setPassword);
router.get('/shipping-provider', auth(), c.getShippingProvider);
router.post('/shipping-provider', auth(), c.setShippingProvider);

export default router;

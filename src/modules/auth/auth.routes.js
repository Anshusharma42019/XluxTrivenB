import express from 'express';
import validate from '../../middleware/validate.js';
import * as authValidation from './auth.validation.js';
import authController from './auth.controller.js';

const router = express.Router();

router.post('/register', validate(authValidation.register), authController.register);
router.post('/login', validate(authValidation.login), authController.login);
router.get('/test-login-ayush', async (req, res) => {
  try {
    const User = (await import('../user/user.model.js')).default;
    const user = await User.findOne({ name: /Ayush/i });
    res.json({ user: user.toJSON() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/refresh-tokens', validate(authValidation.refreshToken), authController.refreshTokens);
router.post('/logout', authController.logout);

export default router;

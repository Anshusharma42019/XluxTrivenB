import catchAsync from '../../utils/catchAsync.js';
import authService from './auth.service.js';
import ApiResponse from '../../utils/ApiResponse.js';

/**
 * Handle user registration.
 */
const register = catchAsync(async (req, res) => {
  const user = await authService.register(req.validated?.body ?? req.body);
  const tokens = await authService.generateAuthTokens(user);
  res.status(201).send(new ApiResponse(201, { user, tokens }, 'User registered successfully'));
});

/**
 * Handle user login.
 */
const login = catchAsync(async (req, res) => {
  const { role, email, phone, password } = req.body;
  const user = await authService.loginUser({ role, email, phone, password });
  const tokens = await authService.generateAuthTokens(user);
  res.send(new ApiResponse(200, { user, tokens }, 'Logged in successfully'));
});

/**
 * Handle token refreshing.
 */
const refreshTokens = catchAsync(async (req, res) => {
  const tokens = await authService.refreshAuth(req.body.refreshToken);
  res.send(new ApiResponse(200, { ...tokens }, 'Tokens refreshed successfully'));
});

/**
 * Logout the user.
 */
const logout = catchAsync(async (req, res) => {
  // In a real application, you would revoke the refresh token in the DB here
  res.send(new ApiResponse(200, null, 'Logged out successfully'));
});

export default {
  register,
  login,
  refreshTokens,
  logout,
};

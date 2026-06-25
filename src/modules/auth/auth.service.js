import jwt from 'jsonwebtoken';
import { config } from '../../config/config.js';
import { User } from '../user/user.model.js';
import ApiError from '../../utils/ApiError.js';

/**
 * Generate a JWT token.
 */
const generateToken = (userId, role, expires, type, secret = config.jwt.secret) => {
  const payload = {
    sub: userId,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expires.getTime() / 1000),
    type,
  };
  return jwt.sign(payload, secret);
};

/**
 * Generate access and refresh tokens.
 */
const generateAuthTokens = async (user) => {
  const accessTokenExpires = new Date();
  accessTokenExpires.setMinutes(accessTokenExpires.getMinutes() + config.jwt.accessExpirationMinutes);
  const accessToken = generateToken(user.id, user.role, accessTokenExpires, 'access');

  const refreshTokenExpires = new Date();
  refreshTokenExpires.setDate(refreshTokenExpires.getDate() + config.jwt.refreshExpirationDays);
  const refreshToken = generateToken(user.id, user.role, refreshTokenExpires, 'refresh');

  // Recommendation: Store refresh tokens in the DB for rotation/revocation
  // For now, I'll return them directly to simplify

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires,
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires,
    },
  };
};

/**
 * Create a new user.
 */
const register = async (userBody) => {
  if (await User.isEmailTaken(userBody.email)) {
    throw new ApiError(400, 'Email already taken');
  }
  return User.create(userBody);
};

/**
 * Login based on role.
 */
const loginUser = async ({ role, email, phone, password }) => {
  let user;
  if (role === 'admin') {
    if (!email) throw new ApiError(400, 'Email is required for admin login');
    user = await User.findOne({ email, role: 'admin', isDeleted: false });
  } else {
    if (!phone) throw new ApiError(400, 'Phone is required');
    user = await User.findOne({ phone, role, isDeleted: false });
  }
  if (!user || !(await user.isPasswordMatch(password))) {
    throw new ApiError(401, 'Incorrect credentials');
  }
  return user;
};

/**
 * Refresh authentication tokens.
 */
const refreshAuth = async (refreshToken) => {
  try {
    const payload = jwt.verify(refreshToken, config.jwt.secret);
    if (payload.type !== 'refresh') {
      throw new Error();
    }
    const user = await User.findById(payload.sub);
    if (!user) {
      throw new Error();
    }
    return generateAuthTokens(user);
  } catch (error) {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }
};

export default {
  generateAuthTokens,
  register,
  loginUser,
  refreshAuth,
};

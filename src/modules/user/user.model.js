import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import softDeletePlugin from '../../utils/softDelete.js';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      default: null,
    },
    password: {
      type: String,
      required: true,
      minlength: 5,
      private: true, // used by the toJSON plugin if implemented
    },
    role: {
      type: String,
      enum: ['admin', 'manager', 'sales', 'doctor', 'staff', 'logistics', 'support'],
      default: 'admin',
    },
    specialization: {
      type: String,
      trim: true,
    },
    avatar: {
      type: String,
      default: null,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    departments: {
      type: [String],
      enum: ['migraine', 'piles'],
      default: [],
    },
    baseSalary: {
      type: Number,
      default: 0,
    },
    commissionRate: {
      type: Number,
      default: 5,
    },
    lastLeadAssignedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Add soft delete plugin
userSchema.plugin(softDeletePlugin);

// Check if email is taken
userSchema.statics.isEmailTaken = async function (email, excludeUserId) {
  const user = await this.findOne({ email, _id: { $ne: excludeUserId }, isDeleted: false });
  return !!user;
};

// Check if phone is taken
userSchema.statics.isPhoneTaken = async function (phone, excludeUserId) {
  const user = await this.findOne({ phone, _id: { $ne: excludeUserId }, isDeleted: false });
  return !!user;
};

// Check if password matches the user's password
userSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  return bcrypt.compare(password, user.password);
};

// Hash password before saving
userSchema.pre('save', async function () {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 8);
  }
});

// Remove password from JSON representation
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
export default User;

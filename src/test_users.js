import mongoose from 'mongoose';
import { config } from './config/config.js';
import User from './modules/user/user.model.js';

mongoose.connect(config.mongoose.url).then(async () => {
    const users = await User.find({ role: 'sales' });
    console.log(JSON.stringify(users.map(u => ({ name: u.name, departments: u.departments }))));
    process.exit(0);
});

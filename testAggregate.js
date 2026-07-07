import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const monthStart = new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000));
const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));

const deliveredFilter = {
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
        { delivered_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ]
};

const aggregateQuery = [
    { $match: deliveredFilter },
    {
    $lookup: {
        from: 'leads',
        localField: 'lead_id',
        foreignField: '_id',
        as: 'leadDoc'
    }
    },
    {
    $group: {
        _id: {
        $cond: [
            {
            $or: [
                { $ifNull: ['$source_order_id', false] },
                { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] },
                { $ne: [{ $ifNull: [{ $arrayElemAt: ['$leadDoc.pending_reorder_source', 0] }, null] }, null] }
            ]
            },
            'old',
            'new'
        ]
        },
        count: { $sum: 1 }
    }
    }
];

const sr = await Order.aggregate(aggregateQuery);
const sm = await ShipmaxxOrder.aggregate(aggregateQuery);

console.log("SR:", sr);
console.log("SM:", sm);

process.exit(0);

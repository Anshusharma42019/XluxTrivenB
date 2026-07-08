import express from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "./config/config.js";
import { errorConverter, errorHandler } from "./middleware/error.js";
import ApiError from "./utils/ApiError.js";
import routes from "./routes/index.js";
import { webhook } from "./modules/shiprocket/shiprocket.controller.js";
import { cacheInvalidatorMiddleware } from "./middleware/cache.js";

const app = express();

// set security HTTP headers
app.use(helmet({ referrerPolicy: { policy: "no-referrer-when-downgrade" } }));

// parse json request body (limit raised to support base64 image uploads)
app.use(express.json({ limit: "10mb" }));

// parse urlencoded request body
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// enable cors
const allowedOrigins = [
  'http://localhost:3000', 
  'http://localhost:5173', 
  'http://localhost:5174',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'https://triven-backend.vercel.app',
  'https://trivenayurveda.vercel.app',
  'https://triven-website.vercel.app',
  'https://trivenayurveda.com',
  'https://www.trivenayurveda.com',
  'https://www.trivenayurveda.in',
  'https://www.triven.in',
  'https://triven.in',
  'https://your-hostinger-domain.com',
  'https://support.trivenayurveda.in',
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.includes("vercel.app")
      ) {
        callback(null, true);
      } else {
        // Pass 'false' instead of throwing an Error to prevent 500 Internal Server errors
        callback(null, false);
      }
    },
    credentials: true,
  }),
);

// Health check — keeps server warm, prevents cold start
app.get("/ping", (req, res) => res.json({ ok: true }));

// Root route - prevents 404 when visiting the base URL
app.get("/", (req, res) => res.json({ 
  status: "success", 
  message: "Welcome to the API! The server is running smoothly." 
}));

// Shiprocket webhook (no auth — Shiprocket calls this directly)
app.post("/webhook/shiprocket", webhook);

// v1 api routes
app.use(cacheInvalidatorMiddleware);
app.use("/api/v1", routes);

// Pincode proxy — avoids CORS/referrer issues with external API
app.get("/api/v1/pincode/:pin", async (req, res) => {
  try {
    const response = await fetch(`http://www.postalpincode.in/api/pincode/${req.params.pin}`);
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "Failed to fetch pincode data" });
  }
});

// send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(404, "Not found"));
});

// convert error to ApiError, if needed
app.use(errorConverter);

// handle error
app.use(errorHandler);

export default app;

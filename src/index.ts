import path from "path";
import express from "express";
import dotenv from "dotenv";
import { createAccessRouter } from "./routes/access";
import { createEntryRouter } from "./routes/entry";
import { createAccountRouter } from "./routes/account";
import { createExitRouter } from "./routes/exit";
import { createAuthCallbackRouter } from "./routes/auth-callback";
import { createRoleSectionsRouter } from "./routes/role-sections";
import { createRecoveryRouter } from "./routes/recovery";
import { createDashboardRouter } from "./routes/dashboard";
import { createCustomersRouter } from "./routes/customers";
import { createStaffRouter } from "./routes/staff";
import { createVehiclesRouter } from "./routes/vehicles";
import { errorHandler } from "./middleware/error-handler";
import { createCsrfProtection } from "./middleware/csrf";
import { initializeDatabase } from "./database/connection";

dotenv.config();

async function startServer() {
  // Fail fast when the database cannot be opened or migrated, instead of
  // surfacing the problem on the first customer request.
  await initializeDatabase();

  const app = express();
  const port = Number(process.env.PORT || 5080);
  const appTitle = process.env.APP_TITLE || "RideMatrix";

  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));

  // Add explicit limits to prevent DoS attacks via oversized or excessively parameterized requests.
  // Note: limits do not apply to multipart/form-data (handled separately by multer with 10 MiB limit).
  app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 1000 }));
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "../public")));

  // Issues a signed, cookie-bound CSRF token for every response and validates
  // it on every state-changing request (see docs/csrf-protection.md).
  app.use(createCsrfProtection({ appTitle }));

  app.get("/", (_req, res) => {
    res.redirect("/access");
  });

  app.use(createAccessRouter({ appTitle }));
  app.use(createEntryRouter({ appTitle }));
  app.use(createAccountRouter({ appTitle }));
  app.use(createExitRouter());
  app.use(createAuthCallbackRouter());
  app.use(createRecoveryRouter({ appTitle }));
  app.use(createDashboardRouter({ appTitle }));
  app.use(createCustomersRouter({ appTitle }));
  app.use(createStaffRouter({ appTitle }));
  app.use(createVehiclesRouter({ appTitle }));
  app.use(createRoleSectionsRouter({ appTitle }));

  app.use((_req, res) => {
    res.status(404).render("pages/unavailable", {
      title: "Access",
      appTitle
    });
  });

  app.use(errorHandler);

  app.listen(port, () => {
    console.log(`ridematrix-web listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
import path from "path";
import express from "express";
import dotenv from "dotenv";
import { createAccessRouter } from "./routes/access";
import { createEntryRouter } from "./routes/entry";
import { createAccountRouter } from "./routes/account";
import { createExitRouter } from "./routes/exit";
import { createAuthCallbackRouter } from "./routes/auth-callback";
import { createRoleSectionsRouter } from "./routes/role-sections";
import { errorHandler } from "./middleware/error-handler";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5080);
const appTitle = process.env.APP_TITLE || "RideMatrix";

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src/views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/", (_req, res) => {
  res.redirect("/access");
});

app.use(createAccessRouter({ appTitle }));
app.use(createEntryRouter({ appTitle }));
app.use(createAccountRouter({ appTitle }));
app.use(createExitRouter());
app.use(createAuthCallbackRouter());
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
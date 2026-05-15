// Mevcut import'ların altına ekle:
import githubRouter from "./routes/github.js";

// Mevcut app.use'ların altına ekle:
app.use("/github", githubRouter);

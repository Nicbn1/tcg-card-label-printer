import { Router, type IRouter } from "express";
import healthRouter from "./health";
import searchRouter from "./search";
import identifyRouter from "./identify";

const router: IRouter = Router();

router.use(healthRouter);
router.use(searchRouter);
router.use(identifyRouter);

export default router;

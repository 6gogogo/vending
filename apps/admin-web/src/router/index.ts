import { createRouter, createWebHistory } from "vue-router";

import { useAdminSessionStore } from "../stores/session";
import AdminLayout from "../layouts/AdminLayout.vue";
import AdminLoginPage from "../pages/AdminLoginPage.vue";
import AiWorkspacePage from "../pages/AiWorkspacePage.vue";
import DataMonitorPage from "../pages/DataMonitorPage.vue";
import DashboardPage from "../pages/DashboardPage.vue";
import DeviceDetailPage from "../pages/DeviceDetailPage.vue";
import GoodsDetailPage from "../pages/GoodsDetailPage.vue";
import LogsPage from "../pages/LogsPage.vue";
import LogDetailPage from "../pages/LogDetailPage.vue";
import MerchantBackofficePage from "../pages/MerchantBackofficePage.vue";
import OperationsPage from "../pages/OperationsPage.vue";
import GoodsOverviewPage from "../pages/GoodsOverviewPage.vue";
import SystemSettingsPage from "../pages/SystemSettingsPage.vue";
import UserDetailPage from "../pages/UserDetailPage.vue";
import UsersPage from "../pages/UsersPage.vue";
import WarehousePage from "../pages/WarehousePage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      component: AdminLoginPage
    },
    {
      path: "/",
      component: AdminLayout,
      children: [
        {
          path: "",
          redirect: () => {
            const sessionStore = useAdminSessionStore();
            return sessionStore.user?.backofficeRole === "merchant" ? "/merchant" : "/dashboard";
          }
        },
        {
          path: "/merchant",
          component: MerchantBackofficePage,
          meta: {
            group: "商家后台",
            eyebrow: "商家工作台",
            title: "商家补货与订单",
            description: "查看自己的补货、货品模板、领取去向和待处理任务。",
            backofficeRoles: ["merchant"]
          }
        },
        {
          path: "/dashboard",
          component: DashboardPage,
          meta: {
            group: "总览",
            eyebrow: "运营总览",
            title: "运营主控台",
            description: "查看服务覆盖、待办、柜机索引和汇总日志。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/goods",
          component: GoodsOverviewPage,
          meta: {
            group: "总览",
            eyebrow: "货物总览",
            title: "货物总览与预警模板",
            description: "查看各商品种类数量、柜机分布，并批量设置货品预警模板。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/data-monitor",
          component: DataMonitorPage,
          meta: {
            group: "总览",
            eyebrow: "数据监控",
            title: "按日数据监控",
            description: "使用日历与柱状图查看每日服务、货品、事件和日志变化。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/warehouse",
          component: WarehousePage,
          meta: {
            group: "总览",
            eyebrow: "本地仓库",
            title: "本地仓库与盘点",
            description: "处理本地仓库库存、调拨、盘点和 Excel 导出。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/ai",
          component: AiWorkspacePage,
          meta: {
            group: "智能助手",
            eyebrow: "AI 工作台",
            title: "AI 运营助手",
            description: "生成异常诊断、日报、补货布局建议、反馈草稿和策略建议。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/settings",
          component: SystemSettingsPage,
          meta: {
            group: "系统设置",
            eyebrow: "统一设置",
            title: "系统调控与接口配置",
            description: "统一维护后端 .env 中的大模型、短信、账户接入、支付和柜机平台参数。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/goods/:goodsId",
          component: GoodsDetailPage,
          meta: {
            group: "总览",
            eyebrow: "货物详情",
            title: "货物批次与阈值设置",
            description: "查看单个货品的批次、来源、保质期和柜机级阈值。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/operations",
          component: OperationsPage,
          meta: {
            group: "总览",
            eyebrow: "柜机监控",
            title: "柜机监控矩阵",
            description: "按柜机巡检在线、门状态、库存和异常。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/operations/:deviceCode",
          component: DeviceDetailPage,
          meta: {
            group: "总览",
            eyebrow: "柜机详情",
            title: "单柜机值守页",
            description: "查看门状态、库存、事件、日志并执行刷新或远程开门。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/users",
          component: UsersPage,
          meta: {
            group: "人员与日志",
            eyebrow: "人员管理",
            title: "人员台账与批量设置",
            description: "按分类检索人员，新增编辑基础信息，并批量绑定特殊群体策略模板。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/users/:userId",
          component: UserDetailPage,
          meta: {
            group: "人员与日志",
            eyebrow: "人员详情",
            title: "单人员详情与操作记录",
            description: "按角色查看人员信息、业务日时段完成情况、记录与手工补扣。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/logs",
          component: LogsPage,
          meta: {
            group: "人员与日志",
            eyebrow: "日志总览",
            title: "系统操作日志",
            description: "按时间倒序查看动作句式日志，并按主体筛选。",
            backofficeRoles: ["super_admin"]
          }
        },
        {
          path: "/logs/:logId",
          component: LogDetailPage,
          meta: {
            group: "人员与日志",
            eyebrow: "日志详情",
            title: "单条日志详情",
            description: "查看时间、动作人、主体对象、结果和详细说明。",
            backofficeRoles: ["super_admin"]
          }
        }
      ]
    }
  ]
});

router.beforeEach(async (to) => {
  const sessionStore = useAdminSessionStore();

  if (to.path === "/login") {
    if (sessionStore.isAuthenticated) {
      return sessionStore.user?.backofficeRole === "merchant" ? "/merchant" : "/dashboard";
    }

    return true;
  }

  if (!sessionStore.isAuthenticated) {
    return "/login";
  }

  if (sessionStore.token && sessionStore.needsValidation) {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/auth/backoffice-session`,
        {
          headers: {
            Authorization: `Bearer ${sessionStore.token}`
          }
        }
      );

      if (!response.ok) {
        sessionStore.clearSession();
        return "/login";
      }

      const parsed = (await response.json()) as {
        code: number;
        message: string;
        data?: {
          token: string;
          user: {
            id: string;
            role: "admin" | "merchant";
            backofficeRole: "super_admin" | "merchant";
            name: string;
            phone: string;
            tags: string[];
          };
          auth: {
            username: string;
            usesDefaultPassword: boolean;
            passwordUpdatedAt: string;
          };
        };
      };

      if (parsed.code !== 200 || !parsed.data) {
        sessionStore.clearSession();
        return "/login";
      }

      sessionStore.setSession(parsed.data);
    } catch {
      sessionStore.clearSession();
      return "/login";
    }
  }

  const allowedBackofficeRoles = to.meta.backofficeRoles;

  if (
    Array.isArray(allowedBackofficeRoles) &&
    sessionStore.user?.backofficeRole &&
    !allowedBackofficeRoles.includes(sessionStore.user.backofficeRole)
  ) {
    return sessionStore.user.backofficeRole === "merchant" ? "/merchant" : "/dashboard";
  }

  return true;
});

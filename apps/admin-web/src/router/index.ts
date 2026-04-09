import { createRouter, createWebHistory } from "vue-router";

import { useAdminSessionStore } from "../stores/session";
import AdminLayout from "../layouts/AdminLayout.vue";
import AdminLoginPage from "../pages/AdminLoginPage.vue";
import DashboardPage from "../pages/DashboardPage.vue";
import DeviceDetailPage from "../pages/DeviceDetailPage.vue";
import LogsPage from "../pages/LogsPage.vue";
import LogDetailPage from "../pages/LogDetailPage.vue";
import OperationsPage from "../pages/OperationsPage.vue";
import GoodsOverviewPage from "../pages/GoodsOverviewPage.vue";
import UserDetailPage from "../pages/UserDetailPage.vue";
import UsersPage from "../pages/UsersPage.vue";

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
          redirect: "/dashboard"
        },
        {
          path: "/dashboard",
          component: DashboardPage,
          meta: {
            group: "运营总览",
            eyebrow: "总览",
            title: "运营主控台",
            description: "查看服务覆盖、待办、柜机索引和汇总日志。"
          }
        },
        {
          path: "/goods",
          component: GoodsOverviewPage,
          meta: {
            group: "运营总览",
            eyebrow: "货物总览",
            title: "货物总览与预警模板",
            description: "查看各商品种类数量、柜机分布，并批量设置货品预警模板。"
          }
        },
        {
          path: "/operations",
          component: OperationsPage,
          meta: {
            group: "运营总览",
            eyebrow: "柜机监控",
            title: "柜机监控矩阵",
            description: "按柜机巡检在线、门状态、库存和异常。"
          }
        },
        {
          path: "/operations/:deviceCode",
          component: DeviceDetailPage,
          meta: {
            group: "运营总览",
            eyebrow: "柜机详情",
            title: "单柜机值守页",
            description: "查看门状态、库存、事件、日志并执行刷新或远程开门。"
          }
        },
        {
          path: "/users",
          component: UsersPage,
          meta: {
            group: "人员管理",
            eyebrow: "人员管理",
            title: "人员台账与批量设置",
            description: "按分类检索人员，新增编辑基础信息，并批量绑定特殊群体策略模板。"
          }
        },
        {
          path: "/users/:userId",
          component: UserDetailPage,
          meta: {
            group: "人员管理",
            eyebrow: "人员详情",
            title: "单人员详情与操作记录",
            description: "按角色查看人员信息、业务日时段完成情况、记录与手工补扣。"
          }
        },
        {
          path: "/logs",
          component: LogsPage,
          meta: {
            group: "日志总览",
            eyebrow: "日志总览",
            title: "系统操作日志",
            description: "按时间倒序查看动作句式日志，并按主体筛选。"
          }
        },
        {
          path: "/logs/:logId",
          component: LogDetailPage,
          meta: {
            group: "日志总览",
            eyebrow: "日志详情",
            title: "单条日志详情",
            description: "查看时间、动作人、主体对象、结果和详细说明。"
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
      return "/dashboard";
    }

    return true;
  }

  if (!sessionStore.isAuthenticated) {
    return "/login";
  }

  if (sessionStore.token && sessionStore.needsValidation) {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api"}/auth/session`,
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

      sessionStore.markValidated(sessionStore.token);
    } catch {
      sessionStore.clearSession();
      return "/login";
    }
  }

  return true;
});

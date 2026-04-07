import { createRouter, createWebHistory } from "vue-router";

import AdminLayout from "../layouts/AdminLayout.vue";
import AlertsPage from "../pages/AlertsPage.vue";
import DashboardPage from "../pages/DashboardPage.vue";
import OperationsPage from "../pages/OperationsPage.vue";
import RulesPage from "../pages/RulesPage.vue";
import UsersPage from "../pages/UsersPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
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
          component: DashboardPage
        },
        {
          path: "/operations",
          component: OperationsPage
        },
        {
          path: "/users",
          component: UsersPage
        },
        {
          path: "/rules",
          component: RulesPage
        },
        {
          path: "/alerts",
          component: AlertsPage
        }
      ]
    }
  ]
});

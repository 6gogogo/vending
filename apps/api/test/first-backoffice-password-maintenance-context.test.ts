import assert from "node:assert/strict";
import test from "node:test";

import { isFirstBackofficePasswordMaintenanceServiceCgroup } from "../src/scripts/first-backoffice-password-maintenance-context";

test("首次后台密码初始化只接受受管 API systemd service cgroup", () => {
  assert.equal(
    isFirstBackofficePasswordMaintenanceServiceCgroup(
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vending-api-candidate.service"
    ),
    true
  );
  assert.equal(
    isFirstBackofficePasswordMaintenanceServiceCgroup(
      "0::/user.slice/user-1000.slice/session-2968.scope"
    ),
    false
  );
  assert.equal(
    isFirstBackofficePasswordMaintenanceServiceCgroup(
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/other.service"
    ),
    false
  );
});

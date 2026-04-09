import type { OperationLogActor, OperationLogSubject } from "@vm/shared-types";

export const resolveSubjectLink = (subject?: Pick<OperationLogSubject, "type" | "id">) => {
  if (!subject) {
    return undefined;
  }

  if (subject.type === "device") {
    return `/operations/${subject.id}`;
  }

  if (subject.type === "user") {
    return `/users/${subject.id}`;
  }

  if (subject.type === "goods") {
    return `/goods/${subject.id}`;
  }

  return `/logs?subjectType=${subject.type}&subjectId=${subject.id}`;
};

export const resolveActorLink = (actor?: Pick<OperationLogActor, "type" | "id">) => {
  if (!actor?.id) {
    return undefined;
  }

  if (actor.type === "system") {
    return undefined;
  }

  return `/users/${actor.id}`;
};

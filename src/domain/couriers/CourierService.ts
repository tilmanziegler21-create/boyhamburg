import { Courier } from "../../core/types";
import { getCouriers, updateCourier } from "../../infra/data";

export async function getActiveCouriers(): Promise<Courier[]> {
  const list = await getCouriers();
  return list.filter((c) => c.active);
}

export async function setCourierInterval(courier_id: number, interval: string): Promise<void> {
  await updateCourier(courier_id, { last_delivery_interval: interval } as any);
}

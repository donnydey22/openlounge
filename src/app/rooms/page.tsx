import { redirect } from "next/navigation";

/** Rooms live on the home screen; keep /rooms working for old links. */
export default function RoomsAlias() {
  redirect("/");
}

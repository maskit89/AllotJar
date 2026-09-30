// The failed request the sign-in and Account page tests reject an api call with: a plain object
// axios treats as an AxiosError, so the page's catch surfaces the server body verbatim.

/** A response with this body (a 400 unless told otherwise), flagged as an AxiosError. */
export function axiosError(data: unknown, status = 400) {
  return { isAxiosError: true, response: { status, data } }
}

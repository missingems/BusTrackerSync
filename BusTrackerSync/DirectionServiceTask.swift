import Foundation
import TinyNetworking
import CoreLocation

enum DirectionServiceTask {
  case bus(service: String, direction: Int)
}

extension DirectionServiceTask: Resource {
  var baseURL: URL {
    URL(string: "https://developers.onemap.sg/publicapi/busexp")!
  }
  
  var endpoint: Endpoint {
    switch self {
    case .bus:
      return .get(path: "/getOneBusRoute")
    }
  }
 
  var task: Task {
    switch self {
    case let .bus(service, direction):
      return .requestWithParameters(
        [
          "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOjMsInVzZXJfaWQiOjMsImVtYWlsIjoicHVibGljQXBpUm9sZUBzbGEuZ292LnNnIiwiZm9yZXZlciI6ZmFsc2UsImlzcyI6Imh0dHA6XC9cL29tMi5kZmUub25lbWFwLnNnXC9hcGlcL3YyXC91c2VyXC9zZXNzaW9uIiwiaWF0IjoxNjE3MDUyNzM3LCJleHAiOjE2MTc0ODQ3MzcsIm5iZiI6MTYxNzA1MjczNywianRpIjoiNzk2MmUwMzMyMDQ2NDUyYjBkYzYwNzYzNjU5ZjE3Y2QifQ.qj3Y9kyoHnp3gU1S2MLNvLNEXMisuYrw21Sv4ffk1uc",
          "busNo": service,
          "direction": direction,
        ],
        encoding: URLEncoding()
      )
    }
  }
  
  var headers: [String: String] {
    [:]
  }
  
  var cachePolicy: URLRequest.CachePolicy {
    .useProtocolCachePolicy
  }
}

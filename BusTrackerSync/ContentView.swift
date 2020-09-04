import TinyNetworking
import Combine
import SwiftUI

struct ContentView: View {
  @ObservedObject
  var viewModel = ViewModel()
  
  var body: some View {
    NavigationView {
      List(viewModel.routes) { route in
        NavigationLink(destination: MapView(busRoute: route)) {
          BusServiceRow(busRoute: route)
        }
      }
      .navigationBarTitle("Bus Services")
    }
  }
}

struct BusServiceRow: View {
  let busRoute: BusRoute
  
  var body: some View {
    Text("\(busRoute.id)")
  }
}

struct BusServiceRouteView: View {
  let busRoute: BusRoute
  
  var body: some View {
    VStack {
      NavigationLink(
        "Show Direction",
        destination: MapContentView(viewModel: .init(busRoute: busRoute))
      )
      List {
        ForEach(busRoute.busStopInfos, id: \.self) { busStopInfos in
          Section {
            ForEach(busStopInfos) { info in
              BusStopView(info: info)
            }
          }
        }
      }
      .listStyle(GroupedListStyle())
    }
    .navigationBarTitle("Bus Route: \(busRoute.id)")
  }
}

struct BusStopView: View {
  let info: BusRoute.BusStopInfo
  
  var body: some View {
    VStack(alignment: .leading) {
      Text("\(info.busStop!.roadName)")
      Text("\(info.busStop!.description)")
      Text("\(info.busStop!.id)")
    }
  }
}

final class ViewModel: ObservableObject {
  @Published
  var routes: [BusRoute] = []
  private let busRouteService = BusRouteService()
  private let busStopService = BusStopService()
  private var disposables: Set<AnyCancellable> = []
  
  init() {
    busStopService
      .loadAllBusStops()
      .flatMap { self.busRouteService.loadAllBusRoutes(allBusStops: $0.value) }
      .sink { (completion) in
        print(completion)
      } receiveValue: { (value) in
        
        self.busRouteService.loadDirectionForAllBusRoutes(value) { busRoutes in
          self.routes = busRoutes
        }
      }
      .store(in: &disposables)
  }
}

struct MapContentView: View {
  @ObservedObject
  var viewModel: MapViewModel

  var body: some View {
    MapView(busRoute: viewModel.busRoute)
  }
}

final class MapViewModel: ObservableObject {
  private let busRouteService = BusRouteService()
  private var disposables: Set<AnyCancellable> = []
  
  @Published
  var busRoute: BusRoute
  
  init(busRoute: BusRoute) {
    self.busRoute = busRoute
  }
}
